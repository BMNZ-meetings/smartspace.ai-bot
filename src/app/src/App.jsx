import "./App.css";
import ChatWidget from "./components/ChatWidget";

function App() {
  return (
    <>
      <div className="card">
        <h1>How can I help?</h1>
        <div className="title-underline"></div>
        <ChatWidget />
      </div>
    </>
  );
}

export default App;
