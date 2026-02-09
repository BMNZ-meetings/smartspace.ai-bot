import "./App.css";
import ChatWidget from "./components/ChatWidget";

function App() {
  // Retrieve email from global variable injected by HubSpot, or default to null
  const userEmail = window.currentUserEmail || null;

  return (
    <>
      <div className="card">
        <h1>How can I help?</h1>
        <div className="title-underline"></div>
        <ChatWidget email={userEmail} />
      </div>
    </>
  );
}

export default App;
