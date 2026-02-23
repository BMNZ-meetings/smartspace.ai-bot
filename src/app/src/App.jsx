import React from "react";
import "./App.css";
import ChatWidget from "./components/ChatWidget";
import localLogo from "./assets/Digital Mentor 247 LOGO.png";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error("[ErrorBoundary]", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "2rem", textAlign: "center" }}>
          <p>Something went wrong. Please refresh the page.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const rootEl = document.getElementById("root");
  const logoUrl = rootEl?.dataset?.logoUrl || localLogo;

  return (
    <>
      <div className="card">
        <img
          src={logoUrl}
          alt="Digital Mentor 24/7"
          className="card-logo"
        />
        <h1>How can I help?</h1>
        <div className="title-underline"></div>
        <ErrorBoundary>
          <ChatWidget />
        </ErrorBoundary>
      </div>
    </>
  );
}

export default App;
