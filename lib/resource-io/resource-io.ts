import type { ResourceEventBus } from "./resource-event-bus.ts";
import { capabilityDenied, providerNotAvailable } from "./errors.ts";
import { normalizeResourceRef } from "./resource-refs.ts";
import type {
  MaterializeResult,
  ResourceDeletedEvent,
  ResourceEdit,
  ResourceEventSource,
  ResourceMutationResult,
  ResourceReadResult,
  ResourceRef,
  ResourceSearchResult,
  ResourceStat,
  ResourceListResult,
} from "./types.ts";

type Provider = {
  capabilities?: (ref: ResourceRef) => Record<string, boolean | undefined>;
  stat?: (ref: ResourceRef) => Promise<ResourceStat>;
  read?: (ref: ResourceRef) => Promise<ResourceReadResult>;
  write?: (ref: ResourceRef, content: string | Buffer) => Promise<ResourceMutationResult>;
  edit?: (ref: ResourceRef, edits: ResourceEdit[]) => Promise<ResourceMutationResult>;
  mkdir?: (ref: ResourceRef) => Promise<ResourceMutationResult>;
  delete?: (ref: ResourceRef) => Promise<ResourceMutationResult>;
  list?: (ref: ResourceRef) => Promise<ResourceListResult>;
  search?: (ref: ResourceRef, options?: Record<string, unknown>) => Promise<ResourceSearchResult>;
  materialize?: (ref: ResourceRef) => Promise<MaterializeResult>;
  copy?: (from: ResourceRef, to: ResourceRef) => Promise<ResourceMutationResult>;
};

type ResourceIOOptions = {
  providers: Record<string, Provider>;
  eventBus?: ResourceEventBus | null;
  getSessionPath?: () => string | null;
};

type MutationOptions = {
  emit?: boolean;
  source?: ResourceEventSource;
  reason?: string;
  sessionPath?: string | null;
};

export class ResourceIO {
  declare providers: Record<string, Provider>;
  declare eventBus: ResourceEventBus | null;
  declare getSessionPath: () => string | null;

  constructor({ providers, eventBus = null, getSessionPath = () => null }: ResourceIOOptions) {
    this.providers = providers || {};
    this.eventBus = eventBus;
    this.getSessionPath = getSessionPath;
  }

  async stat(input: unknown): Promise<ResourceStat> {
    const ref = normalizeResourceRef(input);
    return this.callProvider<ResourceStat>(ref, "stat", ref);
  }

  async read(input: unknown): Promise<ResourceReadResult> {
    const ref = normalizeResourceRef(input);
    return this.callProvider<ResourceReadResult>(ref, "read", ref);
  }

  async write(input: unknown, content: string | Buffer, options: MutationOptions = {}): Promise<ResourceMutationResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceMutationResult>(ref, "write", ref, content);
    this.emitChanged(result, options);
    return result;
  }

  async edit(input: unknown, edits: ResourceEdit[], options: MutationOptions = {}): Promise<ResourceMutationResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceMutationResult>(ref, "edit", ref, edits);
    this.emitChanged(result, options);
    return result;
  }

  async mkdir(input: unknown, options: MutationOptions = {}): Promise<ResourceMutationResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceMutationResult>(ref, "mkdir", ref);
    this.emitChanged(result, options);
    return result;
  }

  async delete(input: unknown, options: MutationOptions = {}): Promise<ResourceMutationResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceMutationResult>(ref, "delete", ref);
    if (options.emit !== false && this.eventBus) {
      this.eventBus.deleted({
        resourceKey: result.resourceKey,
        resource: result.resource,
        source: options.source || "api",
        sessionPath: options.sessionPath ?? this.getSessionPath?.() ?? null,
      } satisfies Omit<ResourceDeletedEvent, "type" | "sequence" | "occurredAt">);
    }
    return result;
  }

  async list(input: unknown): Promise<ResourceListResult> {
    const ref = normalizeResourceRef(input);
    return this.callProvider<ResourceListResult>(ref, "list", ref);
  }

  async search(input: unknown, options: Record<string, unknown> = {}): Promise<ResourceSearchResult> {
    const ref = normalizeResourceRef(input);
    return this.callProvider<ResourceSearchResult>(ref, "search", ref, options);
  }

  async materialize(input: unknown): Promise<MaterializeResult> {
    const ref = normalizeResourceRef(input);
    return this.callProvider<MaterializeResult>(ref, "materialize", ref);
  }

  async copy(from: unknown, to: unknown, options: MutationOptions = {}): Promise<ResourceMutationResult> {
    const fromRef = normalizeResourceRef(from);
    const toRef = normalizeResourceRef(to);
    if (fromRef.kind !== toRef.kind) {
      throw new Error(`cross-provider copy is not implemented: ${fromRef.kind} -> ${toRef.kind}`);
    }
    const result = await this.callProvider<ResourceMutationResult>(toRef, "copy", fromRef, toRef);
    this.emitChanged(result, options);
    return result;
  }

  providerFor(ref: ResourceRef): Provider {
    const id = providerIdForRef(ref);
    const provider = this.providers[id];
    if (!provider) throw providerNotAvailable(id);
    return provider;
  }

  async callProvider<T>(ref: ResourceRef, capability: keyof Provider, ...args: unknown[]): Promise<T> {
    const provider = this.providerFor(ref);
    const capabilities = provider.capabilities?.(ref) || {};
    if (capabilities[capability] === false || typeof provider[capability] !== "function") {
      throw capabilityDenied(String(capability), providerIdForRef(ref));
    }
    return (provider[capability] as (...args: unknown[]) => Promise<T>)(...args);
  }

  emitChanged(result: ResourceMutationResult, options: MutationOptions): void {
    if (options.emit === false || !this.eventBus) return;
    this.eventBus.changed({
      changeType: result.changeType,
      resourceKey: result.resourceKey,
      resource: result.resource,
      ...(result.version ? { version: result.version } : {}),
      source: options.source || "api",
      reason: options.reason,
      sessionPath: options.sessionPath ?? this.getSessionPath?.() ?? null,
    });
  }
}

function providerIdForRef(ref: ResourceRef): string {
  switch (ref.kind) {
    case "local-file":
      return "local_fs";
    case "mount":
      return "mount";
    case "session-file":
      return "session_file";
    case "resource":
      return "resource";
    case "url":
      return "url";
  }
}
