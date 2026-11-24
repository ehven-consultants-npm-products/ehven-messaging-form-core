export interface FormEnhancementOptions {
  status?: HTMLElement;
  timeoutMs?: number;
  verification?: { reset(context: { form: HTMLFormElement }): void | Promise<void> };
  resetOnSuccess?: boolean;
  allowCrossOrigin?: boolean;
  endpoint?: string | URL;
  fetchImpl?: typeof fetch;
  messages?: Partial<Record<'working' | 'accepted' | 'simulated' | 'failure' | 'network', string>>;
}

export interface MessagingFormController {
  readonly pending: boolean;
  destroy(): void;
}

export function enhanceMessagingForm(form: HTMLFormElement, options?: FormEnhancementOptions): MessagingFormController;
export function revealMessagingFields(group: HTMLElement, expanded: boolean, options?: { animate?: boolean; duration?: number }): void;
export function restoreMessagingFields(group: HTMLElement): void;
