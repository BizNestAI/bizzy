// File: BizzyVoiceIcon.jsx
import React, { useEffect, useState, useRef } from 'react';
import { Mic } from 'lucide-react';

const BizzyVoiceIcon = ({ setInput, disabled = false, className = "", title = "Toggle voice", size = 20 }) => {
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef(null);

  useEffect(() => {
    // Web Speech API setup
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setInput(prev => (prev ? `${prev} ${transcript}` : transcript));
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
    };

    recognition.onend = () => {
      setIsRecording(false);
    };

    recognitionRef.current = recognition;
  }, [setInput]);

  const toggleRecording = () => {
    if (disabled) return;
    const recognition = recognitionRef.current;
    if (!recognition) return;

    if (isRecording) {
      recognition.stop();
      setIsRecording(false);
    } else {
      recognition.start();
      setIsRecording(true);
    }
  };

  return (
    <button
      type="button"
      onClick={toggleRecording}
      disabled={disabled}
      aria-label={isRecording ? "Stop voice input" : "Start voice input"}
      aria-pressed={isRecording}
      title={title}
      className={`${className} transition-colors duration-150 ${
        isRecording ? 'text-[var(--accent-contrast)] animate-pulse' : 'text-current'
      } ${disabled ? 'cursor-not-allowed opacity-45' : ''}`}
    >
      <Mic size={size} aria-hidden="true" />
    </button>
  );
};

export default BizzyVoiceIcon;
