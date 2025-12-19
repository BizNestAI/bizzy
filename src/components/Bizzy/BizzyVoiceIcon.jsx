// File: BizzyVoiceIcon.jsx
import React, { useEffect, useState, useRef } from 'react';
import { Mic } from 'lucide-react';

const BizzyVoiceIcon = ({ setInput }) => {
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
      className={`transition-colors duration-300 ${
        isRecording ? 'text-red-500 animate-pulse' : 'text-white hover:text-emerald-400'
      }`}
    >
      <Mic size={20} />
    </button>
  );
};

export default BizzyVoiceIcon;
