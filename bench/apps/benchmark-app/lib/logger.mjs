export function createBenchLogger(base) {
  function emit(kind, event, fields = {}) {
    const entry = {
      ts: new Date().toISOString(),
      kind,
      event,
      ...base,
      ...fields
    };
    console.log(`BENCH_LOG ${JSON.stringify(entry)}`);
  }

  return {
    trigger(event, fields) {
      emit('trigger', event, fields);
    },
    dependency(event, fields) {
      emit('dependency', event, fields);
    },
    lifecycle(event, fields) {
      emit('lifecycle', event, fields);
    },
    sdk(event, fields) {
      emit('sdk', event, fields);
    }
  };
}
