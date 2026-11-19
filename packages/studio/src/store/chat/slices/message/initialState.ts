import type { MessageState } from "../../types";

export const initialMessageState: MessageState = {
  sessions: {},
  sessionIdsByBook: {},
  activeSessionId: null,
  input: "",
  editingMessage: null,
  selectedModel: null,
  selectedService: null,
};
