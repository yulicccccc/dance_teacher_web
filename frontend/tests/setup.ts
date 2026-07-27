// Provide an in-memory IndexedDB implementation so the large-result fallback
// path in useLocalProgress can be exercised under vitest/jsdom.
import 'fake-indexeddb/auto'
