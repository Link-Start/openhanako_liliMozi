export type ResourceRef =
  | { kind: "local-file"; path: string }
  | { kind: "mount"; mountId: string; path: string }
  | { kind: "session-file"; fileId: string; sessionId?: string; sessionPath?: string }
  | { kind: "resource"; resourceId: string }
  | { kind: "url"; url: string };

export type ResourceVersion = {
  mtimeMs?: number;
  size?: number | null;
  sha256?: string;
  etag?: string;
  sequence?: number;
};

export type ResourceDescriptor = ResourceRef & {
  provider?: string;
  filePath?: string;
  displayName?: string;
};

export type ResourceEventSource =
  | "agent_tool"
  | "provider_watch"
  | "api"
  | "bash_reconcile"
  | "mount"
  | "session_file"
  | "unknown";

export type ResourceChangedEvent = {
  type: "resource.changed";
  changeType: "created" | "modified";
  resourceKey: string;
  resource: ResourceDescriptor;
  version?: ResourceVersion;
  source: ResourceEventSource;
  reason?: string;
  sessionPath?: string | null;
  sequence: number;
  occurredAt: string;
};

export type ResourceDeletedEvent = {
  type: "resource.deleted";
  resourceKey: string;
  resource: ResourceDescriptor;
  source: ResourceEventSource;
  sessionPath?: string | null;
  sequence: number;
  occurredAt: string;
};

export type ResourceRenamedEvent = {
  type: "resource.renamed";
  oldResourceKey: string;
  newResourceKey: string;
  oldResource: ResourceDescriptor;
  newResource: ResourceDescriptor;
  source: ResourceEventSource;
  sessionPath?: string | null;
  sequence: number;
  occurredAt: string;
};

export type ResourceEvent =
  | ResourceChangedEvent
  | ResourceDeletedEvent
  | ResourceRenamedEvent;

export type ResourceProviderCapabilities = {
  stat?: boolean;
  read?: boolean;
  write?: boolean;
  edit?: boolean;
  list?: boolean;
  search?: boolean;
  watch?: boolean;
  materialize?: boolean;
  copy?: boolean;
  delete?: boolean;
  mkdir?: boolean;
};

export type ResourceStat = {
  resourceKey: string;
  resource: ResourceDescriptor;
  exists: boolean;
  isDirectory: boolean;
  version?: ResourceVersion;
  filePath?: string;
};

export type ResourceReadResult = {
  resourceKey: string;
  resource: ResourceDescriptor;
  content: Buffer;
  version?: ResourceVersion;
  filePath?: string;
};

export type ResourceMutationResult = {
  changeType: "created" | "modified";
  resourceKey: string;
  resource: ResourceDescriptor;
  version?: ResourceVersion;
  filePath?: string;
};

export type ResourceEdit = {
  oldText: string;
  newText: string;
};

export type ResourceListItem = {
  name: string;
  isDirectory: boolean;
  size: number | null;
  mtimeMs: number;
};

export type ResourceListResult = {
  resourceKey: string;
  resource: ResourceDescriptor;
  items: ResourceListItem[];
};

export type ResourceSearchMatch = {
  filePath: string;
  line: number;
  text: string;
};

export type ResourceSearchResult = {
  resourceKey: string;
  resource: ResourceDescriptor;
  matches: ResourceSearchMatch[];
};

export type MaterializeResult = {
  resourceKey: string;
  resource: ResourceDescriptor;
  filePath: string;
  version?: ResourceVersion;
};
