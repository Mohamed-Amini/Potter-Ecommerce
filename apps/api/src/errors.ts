import type { ApiError } from '@pottery/shared';

export abstract class AppError extends Error {
  abstract readonly code: ApiError['code'];
  abstract readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429;
  readonly field?: string;
}

export class ConflictError extends AppError {
  override readonly name = 'ConflictError';
  readonly code = 'CONFLICT' as const;
  readonly status = 409 as const;
  override readonly field: string;

  constructor(field: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.field = field;
  }
}

export class NotFoundError extends AppError {
  override readonly name = 'NotFoundError';
  readonly code = 'NOT_FOUND' as const;
  readonly status = 404 as const;

  constructor(resource: string, id: string, options?: ErrorOptions) {
    super(`${resource} ${id} not found`, options);
  }
}

export class OutOfStockError extends AppError {
  override readonly name = 'OutOfStockError';
  readonly code = 'OUT_OF_STOCK' as const;
  readonly status = 409 as const;

  constructor(
    readonly productId: string,
    readonly available: number,
    options?: ErrorOptions,
  ) {
    super(`Only ${String(available)} left in stock`, options);
  }
}
