export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type ConnectorFailureStatus =
  | "invalid_request"
  | "request_context_expired"
  | "reauthentication_required"
  | "connector_access_disabled"
  | "tool_not_found"
  | "tool_not_allowed"
  | "rate_limited"
  | "tool_error"
  | "upstream_error"
  | "internal_error"
  // Starter-only: no runtime capability or active local preview session.
  | "binding_unavailable";

export type ConnectorContent = {
  content: Array<{ type: string; [key: string]: Json }>;
  structuredContent?: Json;
};

// Matches Sites Dispatch's explicit invocation outcome, plus binding_unavailable.
export type ConnectorResult =
  | {
      status: "success";
      result: ConnectorContent;
      requestId?: string;
    }
  | {
      status: ConnectorFailureStatus;
      message: string;
      requestId?: string;
      retryAfterMs?: number;
      result?: ConnectorContent;
    };

/** A server-side binding supplied by the runtime, never by a browser. */
export type ConnectorBinding = {
  invoke(
    connectorId: string,
    actionName: string,
    args: { [key: string]: Json },
  ): Promise<ConnectorResult>;
  getContext?(): Promise<ConnectorContext>;
};

/** Site policy and cached tool metadata, not authentication or provider health. */
export type ConnectorContext =
  | {
      status: "success";
      connectors: Array<{
        connectorId: string;
        policy: "enabled" | "disabled";
        tools: Array<{
          actionName: string;
          description?: string;
          inputSchema: Record<string, Json>;
        }> | null;
      }>;
    }
  | {
      status:
        | "request_context_expired"
        | "internal_error"
        | "binding_unavailable"
        | "upstream_error";
    };

// Host context is data, not executable serialization code. Read only own data
// properties; unrelated diagnostics are still omitted by the projection below.
function dataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object")
    throw new Error("Invalid connector context");
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property) return undefined;
  if (!("value" in property)) throw new Error("Invalid connector context");
  return property.value;
}

// One budget covers the entire returned catalog, including every tool schema.
// Values also bound punctuation/numeric output; the byte budget covers JSON
// strings and keys in UTF-8, including their quotes and escape sequences.
// These generous limits prevent shared acyclic graphs from expanding forever.
type ContextBudget = { values: number; stringBytes: number };
const maxSchemaDepth = 64;
const maxContextValues = 100_000;
const maxContextStringBytes = 8 * 1024 * 1024;

function visit(budget: ContextBudget): void {
  if (--budget.values < 0) throw new Error("Connector context is too large");
}

function stringBytes(value: string, budget: ContextBudget): void {
  let bytes = 2; // JSON quotes.
  if (value.length + bytes > budget.stringBytes)
    throw new Error("Connector context is too large");
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6; // Escaped lone surrogate.
    else bytes += 3;
    if (bytes > budget.stringBytes) throw new Error("Connector context is too large");
  }
  budget.stringBytes -= bytes;
}

function record(budget: ContextBudget, keys: string[]): void {
  visit(budget);
  for (const key of keys) stringBytes(key, budget);
}

function text(value: string, budget: ContextBudget): string {
  visit(budget);
  stringBytes(value, budget);
  return value;
}

function dataItems<T>(value: unknown, budget: ContextBudget, project: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid connector context");
  visit(budget);
  const length = dataProperty(value, "length") as number;
  // Each output item costs at least one value. Reject before copying the list
  // or inspecting its entries, rather than allocating an unbounded first pass.
  if (length > budget.values) throw new Error("Connector context is too large");
  const items: T[] = [];
  for (let index = 0; index < length; index++) {
    if (!Object.hasOwn(value, String(index)))
      throw new Error("Invalid connector context");
    items.push(project(dataProperty(value, String(index))));
  }
  return items;
}

function schemaJson(value: unknown, budget: ContextBudget, depth = 0, ancestors = new WeakSet<object>()): Json {
  visit(budget);
  if (depth > maxSchemaDepth) throw new Error("Connector schema is too deep");
  if (typeof value === "string") {
    stringBytes(value, budget);
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || ancestors.has(value))
    throw new Error("Invalid connector schema");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  // Plain objects from another runtime realm and null-prototype JSON records
  // are valid. Class instances such as Date must not supply a toJSON hook.
  if (!array && prototype !== null && Object.getPrototypeOf(prototype) !== null)
    throw new Error("Invalid connector schema");
  const keys = Reflect.ownKeys(value);
  if (keys.length - (array ? 1 : 0) > budget.values)
    throw new Error("Connector context is too large");
  ancestors.add(value);
  try {
    if (array) {
      const length = dataProperty(value, "length") as number;
      if (keys.length !== length + 1) throw new Error("Invalid connector schema");
      const result: Json[] = [];
      for (let index = 0; index < length; index++) {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (!property || !("value" in property) || !property.enumerable)
          throw new Error("Invalid connector schema");
        result.push(schemaJson(property.value, budget, depth + 1, ancestors));
      }
      return result;
    }
    const result: Record<string, Json> = {};
    for (const key of keys) {
      if (typeof key !== "string") throw new Error("Invalid connector schema");
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !("value" in property) || !property.enumerable)
        throw new Error("Invalid connector schema");
      stringBytes(key, budget);
      // Define __proto__ as ordinary JSON data without changing the prototype.
      Object.defineProperty(result, key, {
        value: schemaJson(property.value, budget, depth + 1, ancestors),
        enumerable: true, configurable: true, writable: true,
      });
    }
    return result;
  } finally {
    // Reused acyclic values are allowed; only ancestors identify a cycle.
    ancestors.delete(value);
  }
}

/** Use in a Site server route. Connection selection and credentials stay in the host. */
export function createConnectors(binding: ConnectorBinding | undefined) {
  return {
    async getContext(): Promise<ConnectorContext> {
      if (typeof window !== "undefined") {
        throw new Error(
          "Connected apps are only available in Site server routes.",
        );
      }
      try {
        if (!binding?.getContext) return { status: "binding_unavailable" };
        const context = await binding.getContext();
        const status = dataProperty(context, "status");
        if (status === "success") {
          const budget = { values: maxContextValues, stringBytes: maxContextStringBytes };
          record(budget, ["status", "connectors"]);
          text(status, budget);
          return {
            status: "success",
            connectors: dataItems(dataProperty(context, "connectors"), budget, (connector) => {
              record(budget, ["connectorId", "policy", "tools"]);
              const connectorId = dataProperty(connector, "connectorId");
              const policy = dataProperty(connector, "policy");
              const tools = dataProperty(connector, "tools");
              if (
                typeof connectorId !== "string" ||
                (policy !== "enabled" && policy !== "disabled")
              ) {
                throw new Error("Invalid connector context");
              }
              text(connectorId, budget);
              text(policy, budget);
              if (tools === null) visit(budget);
              return {
                connectorId,
                policy,
                tools: tools === null ? null :
                  dataItems(tools, budget, (tool) => {
                    record(budget, ["actionName", "inputSchema"]);
                    const actionName = dataProperty(tool, "actionName");
                    const description = dataProperty(tool, "description");
                    const inputSchema = dataProperty(tool, "inputSchema");
                    if (
                      typeof actionName !== "string" ||
                      (description !== undefined && typeof description !== "string") ||
                      !inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)
                    ) {
                      throw new Error("Invalid connector tool");
                    }
                    text(actionName, budget);
                    if (description !== undefined) {
                      stringBytes("description", budget);
                      text(description, budget);
                    }
                    return {
                      actionName,
                      ...(description !== undefined
                        ? { description }
                        : {}),
                      inputSchema: schemaJson(inputSchema, budget) as Record<string, Json>,
                    };
                  }),
              };
            }),
          };
        }
        switch (status) {
          case "request_context_expired":
          case "internal_error":
          case "binding_unavailable":
          case "upstream_error":
            return { status };
          default:
            return { status: "upstream_error" };
        }
      } catch {
        return { status: "upstream_error" };
      }
    },
    async invoke(
      connectorId: string,
      actionName: string,
      args: { [key: string]: Json },
    ): Promise<ConnectorResult> {
      if (typeof window !== "undefined") {
        throw new Error(
          "Connected apps are only available in Site server routes.",
        );
      }
      if (!binding) {
        return {
          status: "binding_unavailable",
          message:
            "This runtime does not provide connected apps for this request.",
        };
      }
      try {
        // Preserve the host's status, message, result and optional diagnostics.
        // Do not replay a call after a transport failure: it may have completed.
        return await binding.invoke(connectorId, actionName, args);
      } catch {
        return {
          status: "upstream_error",
          message:
            "The app did not return a confirmed result. The action may have completed; check before trying again.",
        };
      }
    },
  };
}
