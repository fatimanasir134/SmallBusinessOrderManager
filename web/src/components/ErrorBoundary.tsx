import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error?: Error;
}

/** Catches render errors so one broken page doesn't blank the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="content">
        <div className="alert alert-error" role="alert">
          <strong>Something went wrong:</strong> {this.state.error.message}
          <button className="btn btn-small" onClick={() => this.setState({ error: undefined })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
