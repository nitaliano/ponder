import { GraphQLSchema, printSchema } from "graphql";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { EventEmitter } from "@/common/EventEmitter";
import { ensureDirExists } from "@/common/utils";
import { Resources } from "@/Ponder";
import { Schema } from "@/schema/types";

import { buildContractTypes } from "./buildContractTypes";
import { buildEntityTypes } from "./buildEntityTypes";
import { buildEventTypes } from "./buildEventTypes";
import { formatPrettier } from "./utils";

type CodegenServiceEvents = {
  handlerError: (arg: { error: Error }) => void;
  handlerErrorCleared: () => void;
};

export class CodegenService extends EventEmitter<CodegenServiceEvents> {
  resources: Resources;

  constructor({ resources }: { resources: Resources }) {
    super();
    this.resources = resources;
  }

  generateAppFile() {
    const raw = `
      /* Autogenerated file. Do not edit manually. */

      import { PonderApp } from "@ponder/core";
      import type { AppType } from "./app";

      export const ponder = new PonderApp<AppType>();
    `;

    const final = formatPrettier(raw);

    const filePath = path.join(
      this.resources.options.GENERATED_DIR_PATH,
      "index.ts"
    );
    ensureDirExists(filePath);
    writeFileSync(filePath, final, "utf8");
  }

  generateAppTypeFile({ schema }: { schema: Schema }) {
    const contractNames = this.resources.contracts.map(
      (contract) => contract.name
    );
    const entities = schema.entities;

    const raw = `
      /* Autogenerated file. Do not edit manually. */
  
      import type { Block, Log, Transaction } from "@ponder/core";
      import type { AbiParameterToPrimitiveType } from "abitype";
      import type { BlockTag, Hash } from "viem";

      type CallOverrides =
        | {
            /** The block number at which to execute the contract call. */
            blockNumber?: bigint
            blockTag?: never
          }
        | {
            blockNumber?: never
            /** The block tag at which to execute the contract call. */
            blockTag?: BlockTag
          }

      /* CONTRACT TYPES */

      ${buildContractTypes(this.resources.contracts)}
  
      /* ENTITY TYPES */
  
      ${buildEntityTypes(entities)}
  
      /* CONTEXT TYPES */

      export type Context = {
        contracts: {
          ${contractNames.map((name) => `${name}: ${name};`).join("")}
        },
        entities: {
          ${entities
            .map((entity) => `${entity.name}: ${entity.name}Model;`)
            .join("")}
        },
      }
  
      /* HANDLER TYPES */
    
      ${buildEventTypes(this.resources.contracts)}
    `;

    const final = formatPrettier(raw);

    const filePath = path.join(
      this.resources.options.GENERATED_DIR_PATH,
      "app.ts"
    );
    ensureDirExists(filePath);
    writeFileSync(filePath, final, "utf8");
  }

  generateSchemaFile({ graphqlSchema }: { graphqlSchema: GraphQLSchema }) {
    const header = `
      """ Autogenerated file. Do not edit manually. """
    `;

    const body = printSchema(graphqlSchema);
    const final = header + body;

    const filePath = path.join(
      this.resources.options.GENERATED_DIR_PATH,
      "schema.graphql"
    );
    ensureDirExists(filePath);
    writeFileSync(filePath, final, "utf8");
  }
}
