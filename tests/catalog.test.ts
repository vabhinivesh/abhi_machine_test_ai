import { describe, test, expect } from '@jest/globals';
import { searchCatalog } from '../src/agent/tools';

describe('Catalog Search', () => {
  test('should search for pump families', () => {
    const result = searchCatalog('show me all families');
    
    expect(result).toBeDefined();
    if (result.family) {
      expect(result.family.length).toBeGreaterThan(0);
    }
  });

  test('should search for motor options', () => {
    const result = searchCatalog('motor options');
    
    expect(result).toBeDefined();
    if (result.options) {
      expect(result.options.length).toBeGreaterThan(0);
    }
  });

  test('should search for voltage options', () => {
    const result = searchCatalog('voltage');
    
    expect(result).toBeDefined();
  });

  test('should search for seal options', () => {
    const result = searchCatalog('seal');
    
    expect(result).toBeDefined();
  });

  test('should search for material options', () => {
    const result = searchCatalog('material');
    
    expect(result).toBeDefined();
  });

  test('should search for mount options', () => {
    const result = searchCatalog('mount');
    
    expect(result).toBeDefined();
  });

  test('should search for ATEX options', () => {
    const result = searchCatalog('atex');
    
    expect(result).toBeDefined();
  });

  test('should return empty result for non-matching query', () => {
    const result = searchCatalog('xyz123random');
    
    expect(result).toBeDefined();
    expect(result.family).toBeUndefined();
    expect(result.options).toBeUndefined();
  });

  test('should handle multiple search terms', () => {
    const result = searchCatalog('motor voltage');
    
    expect(result).toBeDefined();
  });
});
