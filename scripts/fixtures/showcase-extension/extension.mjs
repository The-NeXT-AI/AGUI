export function activate(context) {
  context.log.info("showcase activated");
  context.commands.registerCommand("fixture.showcase.echo", (...args) => ({
    extensionId: context.extensionId,
    args,
    echoed: true,
    version: "1.0.0",
  }));
  context.commands.registerCommand("fixture.showcase.context", async () => {
    const runs = Number(context.globalState.get("runs", 0)) + 1;
    await context.globalState.update("runs", runs);
    await context.workspaceState.update(
      "lastGreeting",
      context.configuration.get("fixture.showcase.greeting", "hello"),
    );
    return {
      greeting: context.configuration.get("fixture.showcase.greeting", "hello"),
      mode: context.configuration.get("fixture.showcase.mode", "safe"),
      secret: context.secrets.get("FIXTURE_TOKEN"),
      runs,
      workspaceGreeting: context.workspaceState.get("lastGreeting"),
      permissions: context.permissions,
      workspace: context.workspace,
    };
  });
  context.commands.registerCommand("fixture.showcase.storage", async (key, value) => {
    await context.globalState.update(String(key), value);
    return context.globalState.get(String(key));
  });
  context.commands.registerCommand("fixture.showcase.slow", async (delayMs = 200) => {
    const greeting = context.configuration.get("fixture.showcase.greeting", "hello");
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, Number(delayMs) || 0)));
    return { greeting };
  });
}

export function deactivate() {}
