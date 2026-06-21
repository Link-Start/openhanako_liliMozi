export class ResourceIOError extends Error {
  declare code: string;
  declare status: number;

  constructor(message: string, { code = "resource_io_error", status = 400 }: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "ResourceIOError";
    this.code = code;
    this.status = status;
  }
}

export function capabilityDenied(capability: string, providerId: string): ResourceIOError {
  return new ResourceIOError(`ResourceIO capability denied: ${providerId}.${capability}`, {
    code: "capability_denied",
    status: 403,
  });
}

export function providerNotAvailable(providerId: string): ResourceIOError {
  return new ResourceIOError(`ResourceIO provider not available: ${providerId}`, {
    code: "provider_not_available",
    status: 501,
  });
}
