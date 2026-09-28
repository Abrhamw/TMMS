import { Component } from 'react';

/**
 * Catches render/lifecycle errors in a subtree so a single bad page cannot
 * blank the entire app. Resets automatically when `resetKey` changes (route
 * navigation), giving the user a way back without a full reload.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error, info) {
    if (typeof console !== 'undefined') {
      console.error('Page render error:', error, info);
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="main">
          <div className="content">
            <div className="alert alert-error">
              This page failed to display: {String(this.state.error && this.state.error.message || this.state.error)}
            </div>
            <button className="btn mt" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
