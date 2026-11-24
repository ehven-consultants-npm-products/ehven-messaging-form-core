export const MESSAGING_PROTOCOL_VERSION: 1;
export const MESSAGING_FIELD_LIMITS: Readonly<{ firstName: 80; lastName: 80; email: 254; source: 80 }>;

export interface MessagingFieldError { field: string; code: string; message: string }
export interface MessagingIdentity { firstName: string; lastName: string; email: string; source: string }
export type MessagingValues = Record<string, unknown>;

export interface ValidationResult<Data extends object = MessagingIdentity> {
  ok: boolean;
  spam?: boolean;
  errors: MessagingFieldError[];
  data: Data;
}

type IdentityKey = keyof MessagingIdentity;
export interface IdentityOptions {
  fieldNames?: Partial<Record<IdentityKey | 'confirmation' | 'honeypot', string>>;
  limits?: Partial<Record<IdentityKey, number>>;
  required?: Partial<Record<IdentityKey, boolean>>;
  emailConfirmation?: boolean;
  allowedSources?: readonly string[];
  messages?: Readonly<Record<string, string>>;
}

export function createIdentityValidator(options?: IdentityOptions): (values: MessagingValues) => ValidationResult;
export function validateFormIdentity(values: MessagingValues, options?: IdentityOptions): ValidationResult;
