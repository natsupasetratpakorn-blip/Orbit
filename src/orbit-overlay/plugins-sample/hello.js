// Orbit plugin example.
// Copy this file into your Orbit userData/plugins/ directory (the path is
// printed once at startup when plugins:list runs) and restart Orbit to load.
//
// Plugin shape:
//   export default {
//     name: "string",
//     slashCommands: [
//       { name: "/cmd", desc: "string", run: async (api, args) => { ... } }
//     ]
//   }
//
// The `api` object passed to run() exposes:
//   toast(msg, opts)              — show a toast notification
//   sendPrompt(text)              — submit `text` as if the user typed and pressed Enter
//   appendAssistantMessage(text)  — add a system/assistant bubble to the chat
//   getWorkspacePath()            — currently-open workspace, or ""
//   getChatMessages()             — copy of current chat history
//   runWorkspaceCommand(command)  — run a shell command in the workspace
//   readWorkspaceFile(relPath)    — read a file from the workspace
//   openBrowser(url)              — open URL in default external browser

export default {
  name: "hello-plugin",
  slashCommands: [
    {
      name: "/hello",
      desc: "Sample plugin command — say hi",
      run: async (api, args) => {
        api.toast(`👋 Hello from plugin! args=${JSON.stringify(args)}`);
        api.appendAssistantMessage(
          `**Plugin /hello fired.**\n\n` +
          `Workspace: \`${api.getWorkspacePath() || "(none)"}\`\n\n` +
          `Args: \`${args || "(none)"}\``
        );
      }
    }
  ]
};
