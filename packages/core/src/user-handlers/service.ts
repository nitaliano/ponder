import { E_CANCELED, Mutex } from "async-mutex";
import Emittery from "emittery";

import type { HandlerFunctions } from "@/build/handlers";
import type { Contract } from "@/config/contracts";
import { LogEventMetadata, LogFilter } from "@/config/logFilters";
import { UserError } from "@/errors/user";
import type {
  EventAggregatorService,
  LogEvent,
} from "@/event-aggregator/service";
import type { EventStore } from "@/event-store/store";
import type { Resources } from "@/Ponder";
import type { Schema } from "@/schema/types";
import type { ReadOnlyContract } from "@/types/contract";
import type { Model } from "@/types/model";
import type { ModelInstance, UserStore } from "@/user-store/store";
import { formatShortDate } from "@/utils/date";
import { prettyPrint } from "@/utils/print";
import { type Queue, type Worker, createQueue } from "@/utils/queue";
import { wait } from "@/utils/wait";

import { buildReadOnlyContracts } from "./contract";
import { buildModels } from "./model";
import { getStackTrace } from "./trace";

type EventHandlerEvents = {
  eventsProcessed: { toTimestamp: number };
};

type SetupTask = { kind: "SETUP" };
type LogEventTask = { kind: "LOG"; event: LogEvent };
type EventHandlerTask = SetupTask | LogEventTask;
type EventHandlerQueue = Queue<EventHandlerTask>;

export class EventHandlerService extends Emittery<EventHandlerEvents> {
  private resources: Resources;
  private userStore: UserStore;
  private eventAggregatorService: EventAggregatorService;
  private logFilters: LogFilter[];

  private readOnlyContracts: Record<string, ReadOnlyContract> = {};

  private schema?: Schema;
  private models: Record<string, Model<ModelInstance>> = {};

  private handlers?: HandlerFunctions;
  private includeLogFilterEvents: HandlerFunctions["logFilters"] = {};

  private eventProcessingMutex: Mutex;
  private queue?: EventHandlerQueue;

  private eventsProcessedToTimestamp = 0;
  private hasError = false;

  private currentEventBlockNumber = 0n;
  private currentEventTimestamp = 0;

  constructor({
    resources,
    eventStore,
    userStore,
    eventAggregatorService,
    contracts,
    logFilters,
  }: {
    resources: Resources;
    eventStore: EventStore;
    userStore: UserStore;
    eventAggregatorService: EventAggregatorService;
    contracts: Contract[];
    logFilters: LogFilter[];
  }) {
    super();
    this.resources = resources;
    this.userStore = userStore;
    this.eventAggregatorService = eventAggregatorService;
    this.logFilters = logFilters;

    // The read-only contract objects only depend on config, so they can
    // be built in the constructor (they can't be hot-reloaded).
    this.readOnlyContracts = buildReadOnlyContracts({
      contracts,
      getCurrentBlockNumber: () => this.currentEventBlockNumber,
      eventStore,
    });

    this.eventProcessingMutex = new Mutex();
  }

  kill = () => {
    this.queue?.clear();
    this.eventProcessingMutex.cancel();

    this.resources.logger.debug({
      service: "handlers",
      msg: `Killed user handler service`,
    });
  };

  /**
   * Registers a new set of handler functions and/or a new schema, cancels
   * the current event processing mutex & event queue, drops and re-creates
   * all tables from the user store, and resets eventsProcessedToTimestamp to zero.
   *
   * Note: Caller should (probably) immediately call processEvents after this method.
   */
  reset = async ({
    handlers: newHandlers,
    schema: newSchema,
  }: {
    handlers?: HandlerFunctions;
    schema?: Schema;
  } = {}) => {
    if (newSchema) {
      this.schema = newSchema;
      this.models = buildModels({
        userStore: this.userStore,
        schema: this.schema,
        getCurrentEventTimestamp: () => this.currentEventTimestamp,
      });
    }

    if (newHandlers) {
      this.handlers = newHandlers;
      this.includeLogFilterEvents = this.handlers.logFilters;
    }

    // If either the schema or handlers have not been provided yet,
    // we're not ready to process events. Just return early.
    if (!this.schema || !this.handlers) return;

    // Cancel all pending calls to processEvents, reset the mutex, and create
    // a new queue using the latest available handlers and schema.
    this.eventProcessingMutex.cancel();
    this.eventProcessingMutex = new Mutex();
    this.queue = this.createEventQueue({ handlers: this.handlers });

    this.hasError = false;
    this.resources.metrics.ponder_handlers_has_error.set(0);

    this.resources.metrics.ponder_handlers_matched_events.reset();
    this.resources.metrics.ponder_handlers_handled_events.reset();
    this.resources.metrics.ponder_handlers_processed_events.reset();

    await this.userStore.reload({ schema: this.schema });
    this.resources.logger.debug({
      service: "handlers",
      msg: `Reset user store (versionId=${this.userStore.versionId})`,
    });

    // When we call userStore.reload() above, the user store is dropped.
    // Set the latest processed timestamp to zero accordingly.
    this.eventsProcessedToTimestamp = 0;
    this.resources.metrics.ponder_handlers_latest_processed_timestamp.set(0);
  };

  /**
   * This method is triggered by the realtime sync service detecting a reorg,
   * which can happen at any time. The event queue and the user store can be
   * in one of several different states that we need to keep in mind:
   *
   * 1) No events have been added to the queue yet.
   * 2) No unsafe events have been processed (eventsProcessedToTimestamp <= commonAncestorTimestamp).
   * 3) Unsafe events may have been processed (eventsProcessedToTimestamp > commonAncestorTimestamp).
   * 4) The queue has encountered a user error and is waiting for a reload.
   *
   * Note: It's crucial that we acquire a mutex lock while handling the reorg.
   * This will only ever run while the queue is idle, so we can be confident
   * that eventsProcessedToTimestamp matches the current state of the user store,
   * and that no unsafe events will get processed after handling the reorg.
   *
   * Note: Caller should (probably) immediately call processEvents after this method.
   */
  handleReorg = async ({
    commonAncestorTimestamp,
  }: {
    commonAncestorTimestamp: number;
  }) => {
    try {
      await this.eventProcessingMutex.runExclusive(async () => {
        // If there is a user error, the queue & user store will be wiped on reload (case 4).
        if (this.hasError) return;

        if (this.eventsProcessedToTimestamp <= commonAncestorTimestamp) {
          // No unsafe events have been processed, so no need to revert (case 1 & case 2).
          this.resources.logger.debug({
            service: "handlers",
            msg: `No unsafe events were detected while reconciling a reorg, no-op`,
          });
        } else {
          // Unsafe events have been processed, must revert the user store and update
          // eventsProcessedToTimestamp accordingly (case 3).
          await this.userStore.revert({
            safeTimestamp: commonAncestorTimestamp,
          });

          this.eventsProcessedToTimestamp = commonAncestorTimestamp;
          this.resources.metrics.ponder_handlers_latest_processed_timestamp.set(
            commonAncestorTimestamp
          );

          // Note: There's currently no way to know how many events are "thrown out"
          // during the reorg reconciliation, so the event count metrics
          // (e.g. ponder_handlers_processed_events) will be slightly inflated.

          this.resources.logger.debug({
            service: "handlers",
            msg: `Reverted user store to safe timestamp ${commonAncestorTimestamp}`,
          });
        }
      });
    } catch (error) {
      // Pending locks get cancelled in reset(). This is expected, so it's safe to
      // ignore the error that is thrown when a pending lock is cancelled.
      if (error !== E_CANCELED) throw error;
    }
  };

  /**
   * Processes all newly available events.
   *
   * Acquires a lock on the event processing mutex, then gets the latest checkpoint
   * from the event aggregator service. Fetches events between previous checkpoint
   * and the new checkpoint, adds them to the queue, then processes them.
   */
  processEvents = async () => {
    try {
      await this.eventProcessingMutex.runExclusive(async () => {
        if (this.hasError || !this.queue) return;

        const eventsAvailableTo = this.eventAggregatorService.checkpoint;

        // If we have already added events to the queue for the current checkpoint,
        // do nothing and return. This can happen if a number of calls to processEvents
        // "stack up" while one is being processed, and then they all run sequentially
        // but the event aggregator service checkpoint has not moved.
        if (this.eventsProcessedToTimestamp >= eventsAvailableTo) {
          return;
        }

        // The getEvents method is inclusive on both sides, so we need to add 1 here
        // to avoid fetching the same event twice.
        const fromTimestamp =
          this.eventsProcessedToTimestamp === 0
            ? 0
            : this.eventsProcessedToTimestamp + 1;

        const toTimestamp = eventsAvailableTo;

        // If no events have been added yet, add the setup event & associated metrics.
        if (this.eventsProcessedToTimestamp === 0) {
          this.resources.metrics.ponder_handlers_matched_events.inc({
            eventName: "setup",
          });
          if (this.handlers?._meta_.setup) {
            this.queue.addTask({ kind: "SETUP" });
            this.resources.metrics.ponder_handlers_handled_events.inc({
              eventName: "setup",
            });
          }
        }

        const iterator = this.eventAggregatorService.getEvents({
          fromTimestamp,
          toTimestamp,
          includeLogFilterEvents: this.includeLogFilterEvents,
        });

        let pageIndex = 0;

        for await (const page of iterator) {
          const { events, metadata } = page;

          // Increment the metrics for the total number of matching & handled events in this timestamp range.
          if (pageIndex === 0) {
            metadata.counts.forEach(({ logFilterName, selector, count }) => {
              const safeName = Object.values(
                this.logFilters.find((lf) => lf.name === logFilterName)
                  ?.events || {}
              )
                .filter((m): m is LogEventMetadata => !!m)
                .find((m) => m.selector === selector)?.safeName;
              if (!safeName) return;

              const isHandled =
                !!this.handlers?.logFilters[logFilterName]?.bySelector?.[
                  selector
                ];

              this.resources.metrics.ponder_handlers_matched_events.inc(
                { eventName: `${logFilterName}:${safeName}` },
                count
              );
              if (isHandled) {
                this.resources.metrics.ponder_handlers_handled_events.inc(
                  { eventName: `${logFilterName}:${safeName}` },
                  count
                );
              }
            });
          }

          // Add new events to the queue.
          for (const event of events) {
            this.queue.addTask({
              kind: "LOG",
              event,
            });
          }

          // Process new events that were added to the queue.
          this.queue.start();
          await this.queue.onIdle();
          this.queue.pause();

          const { pageEndsAtTimestamp } = metadata;
          this.eventsProcessedToTimestamp = pageEndsAtTimestamp;
          this.emit("eventsProcessed", { toTimestamp: pageEndsAtTimestamp });
          this.resources.metrics.ponder_handlers_latest_processed_timestamp.set(
            pageEndsAtTimestamp
          );

          // This is a hack to ensure that the eventsProcessed handler is called and updates
          // the UI when using SQLite. It also allows the process to GC and handle SIGINT events.
          // It does, however, slow down event processing a bit.
          await wait(0);

          if (events.length > 0) {
            this.resources.logger.info({
              service: "handlers",
              msg: `Processed ${
                events.length === 1 ? "1 event" : `${events.length} events`
              } (up to ${formatShortDate(pageEndsAtTimestamp)})`,
            });
          }

          pageIndex += 1;
        }

        this.eventsProcessedToTimestamp = toTimestamp;
        this.emit("eventsProcessed", { toTimestamp });
        this.resources.metrics.ponder_handlers_latest_processed_timestamp.set(
          toTimestamp
        );
      });
    } catch (error) {
      // Pending locks get cancelled in reset(). This is expected, so it's safe to
      // ignore the error that is thrown when a pending lock is cancelled.
      if (error !== E_CANCELED) throw error;
    }
  };

  private createEventQueue = ({ handlers }: { handlers: HandlerFunctions }) => {
    const context = {
      contracts: this.readOnlyContracts,
      entities: this.models,
    };

    const eventHandlerWorker: Worker<EventHandlerTask> = async ({
      task,
      queue,
    }) => {
      switch (task.kind) {
        case "SETUP": {
          const setupHandler = handlers._meta_.setup?.fn;
          if (!setupHandler) return;

          try {
            // Running user code here!
            await setupHandler({ context });

            this.resources.metrics.ponder_handlers_processed_events.inc({
              eventName: "setup",
            });
          } catch (error_) {
            // Remove all remaining tasks from the queue.
            queue.clear();

            this.hasError = true;
            this.resources.metrics.ponder_handlers_has_error.set(1);

            const error = error_ as Error;
            const trace = getStackTrace(error, this.resources.options);

            const message = `Error while handling "setup" event: ${error.message}`;

            const userError = new UserError(message, {
              stack: trace,
              cause: error,
            });

            this.resources.logger.error({
              service: "handlers",
              error: userError,
            });
            this.resources.errors.submitUserError({ error: userError });
          }

          break;
        }
        case "LOG": {
          const event = task.event;

          const handlerData =
            this.handlers?.logFilters[event.logFilterName].bySafeName[
              event.eventName
            ];
          if (!handlerData)
            throw new Error(
              `Internal: Handler not found for log from log filter ${event.logFilterName}`
            );

          // This enables contract calls occurring within the
          // handler code to use the event block number by default.
          this.currentEventBlockNumber = event.block.number;
          this.currentEventTimestamp = Number(event.block.timestamp);

          try {
            // Running user code here!
            await handlerData.fn({
              event: {
                ...event,
                name: event.eventName,
              },
              context,
            });

            this.resources.metrics.ponder_handlers_processed_events.inc({
              eventName: `${event.logFilterName}:${event.eventName}`,
            });
          } catch (error_) {
            // Remove all remaining tasks from the queue.
            queue.clear();

            this.hasError = true;
            this.resources.metrics.ponder_handlers_has_error.set(1);

            const error = error_ as Error;
            const trace = getStackTrace(error, this.resources.options);

            const message = `Error while handling "${event.logFilterName}:${
              event.eventName
            }" event at block ${Number(event.block.number)}: ${error.message}`;

            const metaMessage = `Event params:\n${prettyPrint(event.params)}`;

            const userError = new UserError(message, {
              stack: trace,
              meta: metaMessage,
              cause: error,
            });

            this.resources.logger.error({
              service: "handlers",
              error: userError,
            });
            this.resources.errors.submitUserError({ error: userError });
          }

          break;
        }
      }
    };

    const queue = createQueue({
      worker: eventHandlerWorker,
      context: undefined,
      options: {
        concurrency: 1,
        autoStart: false,
      },
    });

    return queue;
  };
}
