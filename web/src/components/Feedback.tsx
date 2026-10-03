import { ApiError } from '../api/client';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="muted">{label}</p>;
}

export function ErrorMessage({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const code = error instanceof ApiError ? error.code : undefined;
  return (
    <div className="alert alert-error" role="alert">
      <strong>{code ?? 'Error'}:</strong> {error.message}
      {onRetry && (
        <button className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
