import type { MessagingIdentity, MessagingValues, ValidationResult } from '../index.mjs';

type Awaitable<T> = T | PromiseLike<T>;
export type DeliveryOutcome = 'accepted' | 'simulated';
export type DeliveryResult = { ok: true; outcome?: DeliveryOutcome };
export interface RequestLimits { maxRequestBytes?: number; maxFields?: number; timeoutMs?: number }
export interface VerificationContext<Env> { request: Request; env: Env; formData: FormData; signal: AbortSignal }
export interface RequestDeliveryContext<Env> extends VerificationContext<Env> {
  markAccepted(outcome: DeliveryOutcome): void;
}

export interface MessagingRequestOptions<Env = unknown, Data extends object = MessagingIdentity> extends RequestLimits {
  validate?: (values: MessagingValues, formData: FormData, context: { signal: AbortSignal }) => Awaitable<ValidationResult<Data>>;
  verifyHuman?: (context: VerificationContext<Env>) => Awaitable<{ ok: boolean }>;
  deliver?: (data: Data, context: RequestDeliveryContext<Env>) => Awaitable<void | DeliveryResult>;
  successLocation?: (source: string) => string | undefined;
  simulationLocation?: (source: string) => string | undefined;
  successFallback?: string;
  fields?: readonly string[];
  verificationField?: string;
  messages?: Partial<Record<'accepted' | 'simulated' | 'invalid' | 'verification' | 'unavailable' | 'delivery' | 'request', string>>;
}

export function readBoundedFormData(request: Request, options?: RequestLimits): Promise<FormData>;
export function handleMessagingRequest<Env, Data extends object = MessagingIdentity>(
  request: Request, env: Env, options?: MessagingRequestOptions<Env, Data>
): Promise<Response>;

export interface DeliveryContext {
  signal?: AbortSignal;
  markAccepted?(outcome: DeliveryOutcome): void;
}

type OperationContext<Context> = Omit<Context, 'signal' | 'correlationId'> & { signal: AbortSignal; correlationId: string };
type Acknowledgment =
  | { status: 'skipped' | 'sent' }
  | { status: 'failed'; code: string };

export interface DeliveryPipelineResult extends DeliveryResult {
  outcome: DeliveryOutcome;
  correlationId: string;
  acknowledgment: Acknowledgment;
}

export interface DeliveryPipelineOptions<Data, Context extends DeliveryContext, Primary extends DeliveryResult> {
  accept(data: Data, context: OperationContext<Context>): Awaitable<void | Primary>;
  acknowledge?(data: Data, context: OperationContext<Context> & { primaryResult: void | Primary }): Awaitable<void | { ok: true; outcome?: 'skipped' }>;
  timeoutMs?: number;
  acknowledgmentTimeoutMs?: number;
  onDiagnostic?(event: Readonly<{ correlationId: string; phase: 'primary' | 'acknowledgment'; code: string }>): Awaitable<void>;
}

type DeliveryArgs<Context> = DeliveryContext extends Context ? [context?: Context] : [context: Context];
export function createDeliveryPipeline<Data = MessagingIdentity, Context extends DeliveryContext = DeliveryContext, Primary extends DeliveryResult = DeliveryResult>(
  options: DeliveryPipelineOptions<Data, Context, Primary>
): (data: Data, ...args: DeliveryArgs<Context>) => Promise<DeliveryPipelineResult>;

export class DeliveryPipelineError extends Error {
  constructor(code?: string);
  code: string;
}
