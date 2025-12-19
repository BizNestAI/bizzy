import { useBizzyChatContext } from '../context/BizzyChatContext';

export default function useChatCanvas() {
  const { isCanvasOpen, canvasModule, openCanvas, closeCanvas, messages } = useBizzyChatContext();
  return { isCanvasOpen, canvasModule, openCanvas, closeCanvas, messages };
}
