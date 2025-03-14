import path from "node:path";

import { BuildService } from "@/build/service";
import { CodegenService } from "@/codegen/service";
import { type ResolvedConfig } from "@/config/config";
import { buildContracts } from "@/config/contracts";
import { buildDatabase } from "@/config/database";
import { type LogFilter, buildLogFilters } from "@/config/logFilters";
import { type Network, buildNetwork } from "@/config/networks";
import { type Options } from "@/config/options";
import { UserErrorService } from "@/errors/service";
import { EventAggregatorService } from "@/event-aggregator/service";
import { PostgresEventStore } from "@/event-store/postgres/store";
import { SqliteEventStore } from "@/event-store/sqlite/store";
import { type EventStore } from "@/event-store/store";
import { HistoricalSyncService } from "@/historical-sync/service";
import { LoggerService } from "@/logs/service";
import { MetricsService } from "@/metrics/service";
import { RealtimeSyncService } from "@/realtime-sync/service";
import { ServerService } from "@/server/service";
import { UiService } from "@/ui/service";
import { EventHandlerService } from "@/user-handlers/service";
import { PostgresUserStore } from "@/user-store/postgres/store";
import { SqliteUserStore } from "@/user-store/sqlite/store";
import { type UserStore } from "@/user-store/store";

export type Resources = {
  options: Options;
  logger: LoggerService;
  errors: UserErrorService;
  metrics: MetricsService;
};

export class Ponder {
  resources: Resources;
  logFilters: LogFilter[];

  eventStore: EventStore;
  userStore: UserStore;

  // List of indexing-related services. One per configured network.
  networkSyncServices: {
    network: Network;
    logFilters: LogFilter[];
    historicalSyncService: HistoricalSyncService;
    realtimeSyncService: RealtimeSyncService;
  }[] = [];

  eventAggregatorService: EventAggregatorService;
  eventHandlerService: EventHandlerService;

  serverService: ServerService;
  buildService: BuildService;
  codegenService: CodegenService;
  uiService: UiService;

  constructor({
    options,
    config,
    eventStore,
    userStore,
  }: {
    options: Options;
    config: ResolvedConfig;
    // These options are only used for testing.
    eventStore?: EventStore;
    userStore?: UserStore;
  }) {
    const logger = new LoggerService({
      level: options.logLevel,
      dir: options.logDir,
    });
    const errors = new UserErrorService();
    const metrics = new MetricsService();

    const resources = { options, logger, errors, metrics };
    this.resources = resources;

    const logFilters = buildLogFilters({ options, config });
    this.logFilters = logFilters;
    const contracts = buildContracts({ options, config });
    const networks = config.networks.map((network) =>
      buildNetwork({ network })
    );

    const database = buildDatabase({ options, config });
    this.eventStore =
      eventStore ??
      (database.kind === "sqlite"
        ? new SqliteEventStore({ db: database.db })
        : new PostgresEventStore({ pool: database.pool }));

    this.userStore =
      userStore ??
      (database.kind === "sqlite"
        ? new SqliteUserStore({ db: database.db })
        : new PostgresUserStore({ pool: database.pool }));

    networks.forEach((network) => {
      const logFiltersForNetwork = logFilters.filter(
        (logFilter) => logFilter.network === network.name
      );
      this.networkSyncServices.push({
        network,
        logFilters: logFiltersForNetwork,
        historicalSyncService: new HistoricalSyncService({
          resources,
          eventStore: this.eventStore,
          network,
          logFilters: logFiltersForNetwork,
        }),
        realtimeSyncService: new RealtimeSyncService({
          resources,
          eventStore: this.eventStore,
          network,
          logFilters: logFiltersForNetwork,
        }),
      });
    });

    this.eventAggregatorService = new EventAggregatorService({
      resources,
      eventStore: this.eventStore,
      networks,
      logFilters,
    });

    this.eventHandlerService = new EventHandlerService({
      resources,
      eventStore: this.eventStore,
      userStore: this.userStore,
      eventAggregatorService: this.eventAggregatorService,
      contracts,
      logFilters,
    });

    this.serverService = new ServerService({
      resources,
      userStore: this.userStore,
    });
    this.buildService = new BuildService({ resources, logFilters });
    this.codegenService = new CodegenService({
      resources,
      contracts,
      logFilters,
    });
    this.uiService = new UiService({ resources, logFilters });
  }

  async setup() {
    this.resources.logger.debug({
      service: "app",
      msg: `Started using config file: ${path.relative(
        this.resources.options.rootDir,
        this.resources.options.configFile
      )}`,
    });

    this.registerServiceDependencies();

    // If any of the provided networks do not have a valid RPC url,
    // kill the app here. This happens here rather than in the constructor because
    // `ponder codegen` should still be able to if an RPC url is missing. In fact,
    // that is part of the happy path for `create-ponder`.
    const networksMissingRpcUrl: Network[] = [];
    this.networkSyncServices.forEach(({ network }) => {
      if (!network.rpcUrl) {
        networksMissingRpcUrl.push(network);
      }
    });
    if (networksMissingRpcUrl.length > 0) {
      return new Error(
        `missing RPC URL for networks (${networksMissingRpcUrl.map(
          (n) => `"${n.name}"`
        )}). Did you forget to add an RPC URL in .env.local?`
      );
    }

    // Start the HTTP server.
    await this.serverService.start();

    // These files depend only on ponder.config.ts, so can generate once on setup.
    // Note that loadHandlers depends on the index.ts file being present.
    this.codegenService.generateAppFile();

    // Note that this must occur before loadSchema and loadHandlers.
    await this.eventStore.migrateUp();

    // Manually trigger loading schema and handlers. Subsequent loads
    // are triggered by changes to project files (handled in BuildService).
    this.buildService.buildSchema();
    await this.buildService.buildHandlers();
  }

  async dev() {
    const setupError = await this.setup();
    if (setupError) {
      this.resources.logger.error({
        service: "app",
        msg: setupError.message,
        error: setupError,
      });
      return await this.kill();
    }

    await Promise.all(
      this.networkSyncServices.map(
        async ({ historicalSyncService, realtimeSyncService }) => {
          const { finalizedBlockNumber } = await realtimeSyncService.setup();
          await historicalSyncService.setup({ finalizedBlockNumber });

          historicalSyncService.start();
          realtimeSyncService.start();
        }
      )
    );

    this.buildService.watch();
  }

  async start() {
    const setupError = await this.setup();
    if (setupError) {
      // this.resources.logger.error("error", setupError.message);
      return await this.kill();
    }

    await Promise.all(
      this.networkSyncServices.map(
        async ({ historicalSyncService, realtimeSyncService }) => {
          const { finalizedBlockNumber } = await realtimeSyncService.setup();
          await historicalSyncService.setup({ finalizedBlockNumber });

          historicalSyncService.start();
          realtimeSyncService.start();
        }
      )
    );
  }

  async codegen() {
    this.codegenService.generateAppFile();

    const result = this.buildService.buildSchema();
    if (result) {
      const { schema, graphqlSchema } = result;
      this.codegenService.generateAppFile({ schema });
      this.codegenService.generateSchemaFile({ graphqlSchema });
    }

    await this.kill();
  }

  async kill() {
    this.eventAggregatorService.clearListeners();

    await Promise.all(
      this.networkSyncServices.map(
        async ({ realtimeSyncService, historicalSyncService }) => {
          await realtimeSyncService.kill();
          await historicalSyncService.kill();
        }
      )
    );

    await this.buildService.kill?.();
    this.uiService.kill();
    this.eventHandlerService.kill();
    await this.serverService.kill();
    await this.userStore.teardown();

    this.resources.logger.debug({
      service: "app",
      msg: `Finished shutdown sequence`,
    });
  }

  private registerServiceDependencies() {
    this.buildService.on("newConfig", async () => {
      this.resources.logger.fatal({
        service: "build",
        msg: "Detected change in ponder.config.ts",
      });
      await this.kill();
    });

    this.buildService.on("newSchema", async ({ schema, graphqlSchema }) => {
      this.codegenService.generateAppFile({ schema });
      this.codegenService.generateSchemaFile({ graphqlSchema });

      this.serverService.reload({ graphqlSchema });

      await this.eventHandlerService.reset({ schema });
      await this.eventHandlerService.processEvents();
    });

    this.buildService.on("newHandlers", async ({ handlers }) => {
      await this.eventHandlerService.reset({ handlers });
      await this.eventHandlerService.processEvents();
    });

    this.networkSyncServices.forEach((networkSyncService) => {
      const { chainId } = networkSyncService.network;
      const { historicalSyncService, realtimeSyncService } = networkSyncService;

      historicalSyncService.on("historicalCheckpoint", ({ timestamp }) => {
        this.eventAggregatorService.handleNewHistoricalCheckpoint({
          chainId,
          timestamp,
        });
      });

      historicalSyncService.on("syncComplete", () => {
        this.eventAggregatorService.handleHistoricalSyncComplete({
          chainId,
        });
      });

      realtimeSyncService.on("realtimeCheckpoint", ({ timestamp }) => {
        this.eventAggregatorService.handleNewRealtimeCheckpoint({
          chainId,
          timestamp,
        });
      });

      realtimeSyncService.on("finalityCheckpoint", ({ timestamp }) => {
        this.eventAggregatorService.handleNewFinalityCheckpoint({
          chainId,
          timestamp,
        });
      });

      realtimeSyncService.on("shallowReorg", ({ commonAncestorTimestamp }) => {
        this.eventAggregatorService.handleReorg({ commonAncestorTimestamp });
      });
    });

    this.eventAggregatorService.on("newCheckpoint", async () => {
      await this.eventHandlerService.processEvents();
    });

    this.eventAggregatorService.on(
      "reorg",
      async ({ commonAncestorTimestamp }) => {
        await this.eventHandlerService.handleReorg({ commonAncestorTimestamp });
        await this.eventHandlerService.processEvents();
      }
    );

    this.eventHandlerService.on("eventsProcessed", ({ toTimestamp }) => {
      if (this.serverService.isHistoricalEventProcessingComplete) return;

      // If a batch of events are processed AND the historical sync is complete AND
      // the new toTimestamp is greater than the historical sync completion timestamp,
      // historical event processing is complete, and the server should begin responding as healthy.
      if (
        this.eventAggregatorService.historicalSyncCompletedAt &&
        toTimestamp >= this.eventAggregatorService.historicalSyncCompletedAt
      ) {
        this.serverService.setIsHistoricalEventProcessingComplete();
      }
    });
  }
}
