import type { Sequence } from "../../../types/schema";
import type { MigrationContext } from "../../../types/migration";
import {
  generateCreateSequenceSQL,
  generateDropSequenceSQL,
} from "../../../utils/sql";
import { Logger } from "../../../utils/logger";
import { SQLBuilder } from "../../../utils/sql-builder";
import { ValidationError } from "../../../types/errors";

type NormalizedSequence = {
  dataType: "SMALLINT" | "INTEGER" | "BIGINT";
  increment: string;
  minValue: string;
  maxValue: string;
  start: string;
  cache: string;
  cycle: boolean;
};

export interface SequenceStatementPlan {
  beforeTables: string[];
  afterTables: string[];
}

function normalizeSequenceNumericValue(
  value: number | string | undefined,
  fallback: string
): string {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? fallback : trimmed;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return fallback;
}

function getSequenceTypeBounds(
  dataType: "SMALLINT" | "INTEGER" | "BIGINT"
): { min: string; max: string } {
  if (dataType === "SMALLINT") {
    return { min: "-32768", max: "32767" };
  }

  if (dataType === "INTEGER") {
    return { min: "-2147483648", max: "2147483647" };
  }

  return { min: "-9223372036854775808", max: "9223372036854775807" };
}

function normalizeSequenceDataType(sequence: Sequence): "SMALLINT" | "INTEGER" | "BIGINT" {
  return sequence.dataType ?? "BIGINT";
}

function normalizeSequenceIncrement(value: number | string | undefined): string {
  const normalized = normalizeSequenceNumericValue(value, "1");
  try {
    return BigInt(normalized) === 0n ? "1" : normalized;
  } catch {
    const numeric = Number(normalized);
    return Number.isFinite(numeric) && numeric !== 0 ? String(numeric) : "1";
  }
}

function isAscendingSequenceIncrement(increment: string): boolean {
  try {
    return BigInt(increment) > 0n;
  } catch {
    return Number(increment) > 0;
  }
}

function normalizeOwnedBy(
  ownedBy: string | undefined,
  defaultSchema?: string
): string | undefined {
  if (!ownedBy) {
    return undefined;
  }

  return getOwnedByParts(ownedBy, defaultSchema).join("\u0000");
}

function normalizeSequence(sequence: Sequence): NormalizedSequence {
  const dataType = normalizeSequenceDataType(sequence);
  const increment = normalizeSequenceIncrement(sequence.increment);
  const ascending = isAscendingSequenceIncrement(increment);
  const bounds = getSequenceTypeBounds(dataType);
  const defaultMin = ascending ? "1" : bounds.min;
  const defaultMax = ascending ? bounds.max : "-1";
  const minValue = normalizeSequenceNumericValue(sequence.minValue, defaultMin);
  const maxValue = normalizeSequenceNumericValue(sequence.maxValue, defaultMax);
  const defaultStart = ascending ? minValue : maxValue;
  const start = normalizeSequenceNumericValue(sequence.start, defaultStart);
  const cache = normalizeSequenceNumericValue(sequence.cache, "1");
  const cycle = sequence.cycle ?? false;

  return {
    dataType,
    increment,
    minValue,
    maxValue,
    start,
    cache,
    cycle,
  };
}

function sequenceParametersDiffer(
  desired: NormalizedSequence,
  current: NormalizedSequence
): boolean {
  return (
    desired.dataType !== current.dataType ||
    desired.increment !== current.increment ||
    desired.minValue !== current.minValue ||
    desired.maxValue !== current.maxValue ||
    desired.start !== current.start ||
    desired.cache !== current.cache
  );
}

function getSequenceKey(sequence: Sequence): string {
  return `${sequence.schema || "public"}.${sequence.name}`;
}

function generateOwnedByStatement(sequence: Sequence): string | null {
  if (!sequence.ownedBy) {
    return null;
  }

  const builder = new SQLBuilder();
  builder.p("ALTER SEQUENCE").table(sequence.name, sequence.schema);
  builder.p(
    `OWNED BY ${renderOwnedByTarget(sequence.ownedBy, sequence.schema)}`
  );
  return builder.build() + ";";
}

function generateOwnedByRemovalStatement(sequence: Sequence): string {
  const builder = new SQLBuilder();
  builder.p("ALTER SEQUENCE").table(sequence.name, sequence.schema);
  builder.p("OWNED BY NONE");
  return builder.build() + ";";
}

function unquoteOwnedByPart(part: string): string {
  if (part.startsWith('"') && part.endsWith('"')) {
    return part.slice(1, -1).replace(/""/g, '"');
  }
  return part;
}

function getOwnedByParts(target: string, defaultSchema?: string): string[] {
  const parts = splitOwnedByTarget(target).map(unquoteOwnedByPart);
  if (parts.length === 2) {
    parts.unshift(defaultSchema || "public");
  }
  return parts;
}

function quoteOwnedByPart(identifier: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    return identifier;
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function renderOwnedByTarget(target: string, defaultSchema?: string): string {
  return getOwnedByParts(target, defaultSchema)
    .map(quoteOwnedByPart)
    .join(".");
}

function splitOwnedByTarget(target: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inQuote = false;

  for (let i = 0; i < target.length; i++) {
    const char = target[i];

    if (char === '"') {
      current += char;
      if (inQuote && target[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuote = !inQuote;
      continue;
    }

    if (char === "." && !inQuote) {
      if (current) {
        segments.push(current);
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current) {
    segments.push(current);
  }

  return segments;
}

function generateCreateSequencePlan(
  sequence: Sequence,
  inlineOwnership: boolean
): SequenceStatementPlan {
  if (inlineOwnership) {
    return {
      beforeTables: [generateCreateSequenceSQL(sequence)],
      afterTables: [],
    };
  }
  const createSequence = sequence.ownedBy
    ? { ...sequence, ownedBy: undefined }
    : sequence;
  const plan: SequenceStatementPlan = {
    beforeTables: [generateCreateSequenceSQL(createSequence)],
    afterTables: [],
  };
  const ownedByStatement = generateOwnedByStatement(sequence);
  if (ownedByStatement) {
    plan.afterTables.push(ownedByStatement);
  }
  return plan;
}

function generateDefinitionChangeStatements(
  desired: Sequence,
  current: Sequence
): string[] {
  const statements: string[] = [];
  const normalizedDesired = normalizeSequence(desired);
  const normalizedCurrent = normalizeSequence(current);
  if (sequenceParametersDiffer(normalizedDesired, normalizedCurrent)) {
    const builder = new SQLBuilder()
      .p("ALTER SEQUENCE")
      .table(desired.name, desired.schema);
    if (normalizedDesired.dataType !== normalizedCurrent.dataType) {
      builder.p(`AS ${normalizedDesired.dataType}`);
    }
    statements.push(
      builder
        .p(`INCREMENT BY ${normalizedDesired.increment}`)
        .p(`MINVALUE ${normalizedDesired.minValue}`)
        .p(`MAXVALUE ${normalizedDesired.maxValue}`)
        .p(`START WITH ${normalizedDesired.start}`)
        .p(`CACHE ${normalizedDesired.cache}`)
        .p(";")
        .build()
    );
  }
  if (normalizedDesired.cycle !== normalizedCurrent.cycle) {
    statements.push(
      new SQLBuilder()
        .p("ALTER SEQUENCE")
        .table(desired.name, desired.schema)
        .p(normalizedDesired.cycle ? "CYCLE" : "NO CYCLE")
        .p(";")
        .build()
    );
  }
  return statements;
}

function generatePersistenceChangeStatement(
  desired: Sequence,
  current: Sequence
): string | null {
  if (Boolean(desired.unlogged) === Boolean(current.unlogged)) {
    return null;
  }
  return new SQLBuilder()
    .p("ALTER SEQUENCE")
    .table(desired.name, desired.schema)
    .p(desired.unlogged ? "SET UNLOGGED" : "SET LOGGED")
    .p(";")
    .build();
}

function generateAlterSequencePlan(
  desired: Sequence,
  current: Sequence
): SequenceStatementPlan {
  const plan: SequenceStatementPlan = {
    beforeTables: generateDefinitionChangeStatements(desired, current),
    afterTables: [],
  };

  const persistenceStatement = generatePersistenceChangeStatement(
    desired,
    current
  );
  if (persistenceStatement) {
    plan.beforeTables.push(persistenceStatement);
  }

  if (
    normalizeOwnedBy(desired.ownedBy, desired.schema) !==
    normalizeOwnedBy(current.ownedBy, current.schema)
  ) {
    if (current.ownedBy) {
      plan.beforeTables.push(generateOwnedByRemovalStatement(desired));
    }
    const ownedByStatement = generateOwnedByStatement(desired);
    if (ownedByStatement) {
      plan.afterTables.push(ownedByStatement);
    }
  }
  return plan;
}

function validateUnloggedSequenceSupport(
  desiredSequences: Sequence[],
  context: MigrationContext
): void {
  const unlogged = desiredSequences.find(function findUnlogged(sequence) {
    return sequence.unlogged;
  });
  if (!unlogged) return;

  const identity = `${unlogged.schema || "public"}.${unlogged.name}`;
  if (context.postgresVersionNum === undefined) {
    throw new ValidationError(
      `Cannot safely use unlogged sequence ${identity} without the PostgreSQL server version`,
      identity,
      "unlogged",
      true
    );
  }
  if (context.postgresVersionNum < 150000) {
    const serverMajor = Math.floor(context.postgresVersionNum / 10000);
    throw new ValidationError(
      `PostgreSQL ${serverMajor} does not support unlogged sequences; PostgreSQL 15 or newer is required`,
      identity,
      "unlogged",
      true
    );
  }
}

export class SequenceHandler {
  generateStatements(
    desiredSequences: Sequence[],
    currentSequences: Sequence[],
    context: MigrationContext = {}
  ): string[] {
    const plan = this.generateStatementPlan(
      desiredSequences,
      currentSequences,
      context
    );
    return [...plan.beforeTables, ...plan.afterTables];
  }

  generateStatementPlan(
    desiredSequences: Sequence[],
    currentSequences: Sequence[],
    context: MigrationContext = {}
  ): SequenceStatementPlan {
    validateUnloggedSequenceSupport(desiredSequences, context);
    const plan: SequenceStatementPlan = {
      beforeTables: [],
      afterTables: [],
    };
    const currentMap = new Map(
      currentSequences.map(function mapCurrentSequence(sequence) {
        return [getSequenceKey(sequence), sequence] as const;
      })
    );
    const desiredKeys = new Set(desiredSequences.map(getSequenceKey));

    for (const currentSequence of currentSequences) {
      const key = getSequenceKey(currentSequence);
      if (!desiredKeys.has(key)) {
        if (currentSequence.ownedBy) {
          Logger.info(`sequence '${key}' is owned by a table column, skipping`);
          continue;
        }

        plan.afterTables.push(
          generateDropSequenceSQL(currentSequence.name, currentSequence.schema)
        );
        Logger.info(`Dropping sequence '${key}'`);
      }
    }

    for (const desiredSequence of desiredSequences) {
      const key = getSequenceKey(desiredSequence);
      const currentSequence = currentMap.get(key);

      if (!currentSequence) {
        const createPlan = generateCreateSequencePlan(
          desiredSequence,
          context.renderDesiredSchema === true
        );
        plan.beforeTables.push(...createPlan.beforeTables);
        plan.afterTables.push(...createPlan.afterTables);
        Logger.info(`Creating sequence '${key}'`);
        continue;
      }

      const alterationPlan = generateAlterSequencePlan(
        desiredSequence,
        currentSequence
      );
      if (
        alterationPlan.beforeTables.length > 0 ||
        alterationPlan.afterTables.length > 0
      ) {
        plan.beforeTables.push(...alterationPlan.beforeTables);
        plan.afterTables.push(...alterationPlan.afterTables);
        Logger.info(`Updating sequence '${key}'`);
      } else {
        Logger.info(`sequence '${key}' is up to date, skipping`);
      }
    }

    return plan;
  }
}
