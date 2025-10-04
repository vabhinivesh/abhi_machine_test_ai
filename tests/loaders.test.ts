import { describe, test, expect } from '@jest/globals';
import { DataStore } from '../src/data/loaders';

describe('Data Loaders', () => {
  describe('Catalog Data', () => {
    test('should load catalog with correct structure', () => {
      expect(DataStore.catalog).toBeDefined();
      expect(Array.isArray(DataStore.catalog)).toBe(true);
      expect(DataStore.catalog.length).toBeGreaterThanOrEqual(2);
    });

    test('should have valid catalog entries', () => {
      expect(DataStore.catalog.length).toBeGreaterThan(0);
      DataStore.catalog.forEach(entry => {
        expect(entry.family).toBeTruthy();
        expect(typeof entry.minGpm).toBe('number');
        expect(typeof entry.maxGpm).toBe('number');
        expect(entry.maxGpm).toBeGreaterThan(entry.minGpm);
        expect(typeof entry.maxHeadFt).toBe('number');
        expect(typeof entry.maxHp).toBe('number');
        expect(entry.baseNote).toBeTruthy();
      });
    });

    test('should contain P100 and P200 families', () => {
      const families = DataStore.catalog.map(c => c.family);
      expect(families).toContain('P100');
      expect(families).toContain('P200');
    });
  });

  describe('Options Data', () => {
    test('should load options with correct structure', () => {
      expect(DataStore.options).toBeDefined();
      expect(Array.isArray(DataStore.options)).toBe(true);
      expect(DataStore.options.length).toBeGreaterThan(0);
    });

    test('should have valid option entries', () => {
      expect(DataStore.options.length).toBeGreaterThan(0);
      const firstOption = DataStore.options[0];
      expect(firstOption).toHaveProperty('optionType');
      expect(firstOption).toHaveProperty('optionValue');
    });

    test('should contain motor and voltage options', () => {
      const optionTypes = DataStore.options.map(o => o.optionType);
      expect(optionTypes).toContain('MotorHP');
      expect(optionTypes).toContain('Voltage');
    });
  });

  describe('Flow Head Map Data', () => {
    test('should load flow head map with correct structure', () => {
      expect(DataStore.flowHeadMap).toBeDefined();
      expect(Array.isArray(DataStore.flowHeadMap)).toBe(true);
      expect(DataStore.flowHeadMap.length).toBeGreaterThanOrEqual(4);
    });

    test('should have valid flow head map entries', () => {
      expect(DataStore.flowHeadMap.length).toBeGreaterThan(0);
      DataStore.flowHeadMap.forEach(entry => {
        expect(entry.gpmRange).toBeTruthy();
        expect(entry.headRange).toBeTruthy();
        expect(entry.family).toBeTruthy();
        expect(typeof entry.motorHp).toBe('number');
        expect(entry.impellerCode).toBeTruthy();
      });
    });
  });

  describe('BOM Rules Data', () => {
    test('should load BOM rules with correct structure', () => {
      expect(DataStore.bomRules).toBeDefined();
      expect(DataStore.bomRules.base_components).toBeDefined();
      expect(DataStore.bomRules.impellers).toBeDefined();
      expect(DataStore.bomRules.motors).toBeDefined();
      expect(DataStore.bomRules.seal_kits).toBeDefined();
      expect(DataStore.bomRules.mounts).toBeDefined();
      expect(DataStore.bomRules.coupling).toBeDefined();
      expect(DataStore.bomRules.atex).toBeDefined();
      expect(DataStore.bomRules.fasteners).toBeDefined();
      expect(DataStore.bomRules.finish).toBeDefined();
    });

    test('should have component definitions', () => {
      const impellers = Object.keys(DataStore.bomRules.impellers);
      expect(impellers.length).toBeGreaterThanOrEqual(4);
      
      const motors = Object.keys(DataStore.bomRules.motors);
      expect(motors.length).toBeGreaterThanOrEqual(4);
      
      const sealKits = Object.keys(DataStore.bomRules.seal_kits);
      expect(sealKits.length).toBeGreaterThanOrEqual(4);
      
      const mounts = Object.keys(DataStore.bomRules.mounts);
      expect(mounts.length).toBeGreaterThanOrEqual(2);
    });

    test('should have ATEX package', () => {
      expect(DataStore.bomRules.atex).toBeDefined();
      expect(DataStore.bomRules.atex.sku).toBeTruthy();
      expect(typeof DataStore.bomRules.atex.price).toBe('number');
    });
  });

  describe('Pricing Rules Data', () => {
    test('should load pricing rules with correct structure', () => {
      expect(DataStore.pricingRules).toBeDefined();
      expect(DataStore.pricingRules.default_discount_pct).toBeDefined();
    });

    test('should have valid default discount percentage', () => {
      expect(typeof DataStore.pricingRules.default_discount_pct).toBe('number');
      expect(DataStore.pricingRules.default_discount_pct).toBeGreaterThan(0);
      expect(DataStore.pricingRules.default_discount_pct).toBeLessThanOrEqual(100);
    });
  });

  describe('Data Reload', () => {
    test('should have reload function', () => {
      expect(typeof DataStore.reload).toBe('function');
    });

    test('should reload data without errors', () => {
      expect(() => DataStore.reload()).not.toThrow();
    });
  });
});
