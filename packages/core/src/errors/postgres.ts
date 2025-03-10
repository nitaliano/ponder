import { DatabaseError } from "pg";

import { prettyPrint } from "@/utils/print";

import { BaseError } from "./base";

export class PostgresError extends BaseError {
  name = "PostgresError";

  constructor({
    statement,
    parameters,
    pgError,
  }: {
    statement: string;
    parameters: (string | number | bigint)[];
    pgError: DatabaseError;
  }) {
    const params = parameters.reduce<Record<number, any>>(
      (acc, parameter, idx) => {
        acc[idx + 1] = parameter;
        return acc;
      },
      {}
    );

    const metaMessages = [];
    if (pgError.detail) metaMessages.push(`Detail:\n  ${pgError.detail}`);
    metaMessages.push(`Statement:\n  ${statement}`);
    metaMessages.push(`Parameters:\n${prettyPrint(params)}`);

    const shortMessage = `PostgreSQL error: ${pgError.message}`;

    super(shortMessage, {
      metaMessages,
    });
  }
}
