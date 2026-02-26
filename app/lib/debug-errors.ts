declare global {
  // eslint-disable-next-line no-var
  var __debugErrorHandlersInstalled__: boolean | undefined;
}

if (process.env.NODE_ENV !== 'production' && !globalThis.__debugErrorHandlersInstalled__) {
  globalThis.__debugErrorHandlersInstalled__ = true;

  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    if (reason instanceof Error && reason.stack) {
      console.error(reason.stack);
    }
  });

  process.on('uncaughtException', (error) => {
    console.error('[uncaughtException]', error);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  });
}

export {};
