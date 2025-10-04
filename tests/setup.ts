// Global test setup

// Note: We don't globally mock fs here because @temporalio/testing needs it
// Individual tests can mock fs as needed

// Mock the open function
jest.mock('open', () => jest.fn());

// Mock console methods for cleaner test output
const originalConsole = { ...console };

global.beforeEach(() => {
  // Clear all mocks before each test
  jest.clearAllMocks();
  
  // Mock console methods
  global.console = {
    ...originalConsole,
    log: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
});

global.afterEach(() => {
  // Restore original console methods
  global.console = originalConsole;
});
