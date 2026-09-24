export function isUniqueViolation(
  error: unknown,
): error is { cause: { code: string; constraint_name?: string } } {
  if (typeof error !== 'object' || error === null || !('cause' in error)) return false;
  const cause: unknown = error.cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false;
  return cause.code === '23505'; // well if i forgot this is a unique code valiotion of postgressql
}


const FIELD_BY_CONSTRAINT: Record<string, string> = {
  products_slug_unique: 'slug',
  categories_slug_unique: 'slug',
  users_phone_number_unique: 'phoneNumber',
};

export function conflictingField(error: { cause: { constraint_name?: string } }): string {
  const constraint = error.cause.constraint_name;
  return (constraint !== undefined ? FIELD_BY_CONSTRAINT[constraint] : undefined) ?? 'unknown';
}


export function isForeignKeyViolation(
  error: unknown,
): error is { cause: { code: string; constraint_name?: string } } {
  if (typeof error !== 'object' || error === null || !('cause' in error)) return false;
  const cause: unknown = error.cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false;
  return cause.code === '23503'; 
}
