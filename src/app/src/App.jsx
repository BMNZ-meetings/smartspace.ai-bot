import { useState } from 'react'
import './App.css'
import ChatWidget from './components/ChatWidget'

function App() {
  return (
    <>
      <div className="card">
         <h1>Smartspace Integration Demo</h1>
         <p>Click the chat button below to interact.</p>
      </div>
      <ChatWidget />
    </>
  )
}

export default App
