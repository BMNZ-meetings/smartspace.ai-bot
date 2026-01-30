import { useState } from 'react'
import './App.css'
import ChatWidget from './components/ChatWidget'

function App() {
  // Retrieve email from global variable injected by HubSpot, or default to null
  const userEmail = window.currentUserEmail || null;

  return (
    <>
      <div className="card">
        <h1>Smartspace Integration Demo</h1>
        <p>Click the chat button below to interact.</p>
        <ChatWidget email={userEmail} />
      </div>
    </>
  )
}

export default App
