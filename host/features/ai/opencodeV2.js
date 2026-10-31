// Adapt OpenCode 2 records to the chat pane's existing message and question shapes.
export function promptInput(body) {
  if (typeof body === "string") return { text: body };
  const parts = body?.parts || [];
  const files = parts.filter((part) => part.type === "file").map((part) => ({ uri: part.url }));
  return {
    text: parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
    ...(files.length ? { files } : {})
  };
}

export function messageRecord(message) {
  const parts = (message.content || []).map((part, index) => {
    const id = part.id || `${message.id}:${index}`;
    if (part.type !== "tool") return { ...part, id };
    const state = part.state || {};
    const output = state.output ?? (state.status === "error" ? state.error?.message : null)
      ?? (state.content || []).map((item) => item.text || "").filter(Boolean).join("\n");
    return { ...part, id, tool: part.name, state: { ...state, output } };
  });
  return { info: { ...message, role: message.type }, parts };
}

export const questionFields = (form) => (form.fields || []).filter((field) => !field.hidden && field.type !== "external");

export function questionRecord(form) {
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: questionFields(form).map((field) => ({
      question: field.title || field.description || field.key,
      header: form.title,
      options: field.type === "boolean"
        ? [{ label: "true" }, { label: "false" }]
        : (field.options || []).map((option) => ({ label: option.label || option.value, description: option.description })),
      multiple: field.type === "multiselect",
      custom: field.type !== "boolean" && (!field.options?.length || field.custom === true)
    }))
  };
}

export function formAnswer(form, answers) {
  const answer = {};
  questionFields(form).forEach((field, index) => {
    const values = (answers[index] || []).map((value) =>
      field.options?.find((option) => (option.label || option.value) === value)?.value ?? value);
    if (!values.length) return;
    if (field.type === "multiselect") answer[field.key] = values;
    else if (field.type === "boolean") {
      if (!["true", "false"].includes(values[0])) throw new Error(`Invalid boolean answer for ${field.key}`);
      answer[field.key] = values[0] === "true";
    } else if (field.type === "number" || field.type === "integer") {
      const value = Number(values[0]);
      if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) throw new Error(`Invalid numeric answer for ${field.key}`);
      answer[field.key] = value;
    } else answer[field.key] = values[0];
  });
  return answer;
}
