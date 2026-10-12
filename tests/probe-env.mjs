console.log('probe start');
try {
  const sdk = await import('../tests/regression.bundle.mjs');
  console.log('bundle imported', sdk);
} catch (e) {
  console.error('import threw:', e);
}
console.log('probe end');
