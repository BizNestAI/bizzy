// src/components/Portal.jsx
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export default function Portal({ children }) {
  const elRef = useRef(null);
  if (!elRef.current) {
    const div = document.createElement("div");
    div.setAttribute("data-portal-root", "true");
    elRef.current = div;
  }
  useEffect(() => {
    document.body.appendChild(elRef.current);
    return () => {
      document.body.removeChild(elRef.current);
    };
  }, []);
  return createPortal(children, elRef.current);
}
