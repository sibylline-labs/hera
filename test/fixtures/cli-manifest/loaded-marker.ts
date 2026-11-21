// Every fixture handler module imports this; the completion test asserts it never ran.
process.stderr.write("HERA_FIXTURE_HANDLER_LOADED\n");
export const loaded = true;
