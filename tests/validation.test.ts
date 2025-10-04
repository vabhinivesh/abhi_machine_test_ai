import { describe, test, expect } from '@jest/globals';
import { validateConfiguration } from '../src/agent/tools';
import { PumpConfiguration, PumpRequirements } from '../src/models/types';

describe('Configuration Validation - Edge Cases', () => {
  test('should report missing required fields', () => {
    const config: Partial<PumpConfiguration> = {
      family: 'P100'
      // Missing other required fields
    };

    const requirements: Partial<PumpRequirements> = {
      environment: 'non-ATEX'
    };

    const result = validateConfiguration(config, requirements);
    
    expect(result.isValid).toBe(false);
    expect(result.violations).toContain('Motor HP is required');
    expect(result.violations).toContain('Voltage is required');
    expect(result.violations).toContain('Seal type is required');
    expect(result.violations).toContain('Material is required');
    expect(result.violations).toContain('Mount type is required');
  });

  test('should report all missing fields when config is empty', () => {
    const config: Partial<PumpConfiguration> = {};
    const requirements: Partial<PumpRequirements> = {
      environment: 'non-ATEX'
    };

    const result = validateConfiguration(config, requirements);
    
    expect(result.isValid).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(6);
    expect(result.violations).toContain('Pump family is required');
  });

  test('should validate ATEX with incomplete configuration', () => {
    const config: Partial<PumpConfiguration> = {
      family: 'P200',
      motorHp: 10,
      voltage: '460V_3ph',
      sealType: 'Packing', // Wrong - should be Mechanical
      material: 'Stainless',
      mount: 'Base',
      impeller: 'IMP-180-XL',
      atex: true
    };

    const requirements: Partial<PumpRequirements> = {
      environment: 'ATEX'
    };

    const result = validateConfiguration(config, requirements);
    
    expect(result.isValid).toBe(false);
    expect(result.violations.some(v => v.includes('ATEX'))).toBe(true);
  });

  test('should reject ATEX with CastIron material', () => {
    const config: Partial<PumpConfiguration> = {
      family: 'P200',
      motorHp: 10,
      voltage: '460V_3ph',
      sealType: 'Mechanical',
      material: 'CastIron', // Wrong - should be Stainless
      mount: 'Base',
      impeller: 'IMP-180-XL',
      atex: true
    };

    const requirements: Partial<PumpRequirements> = {
      environment: 'ATEX'
    };

    const result = validateConfiguration(config, requirements);
    
    expect(result.isValid).toBe(false);
    expect(result.violations.some(v => v.includes('ATEX'))).toBe(true);
  });

  test('should reject ATEX with 230V voltage', () => {
    const config: Partial<PumpConfiguration> = {
      family: 'P100',
      motorHp: 3,
      voltage: '230V_1ph', // Wrong for ATEX
      sealType: 'Mechanical',
      material: 'Stainless',
      mount: 'Base',
      impeller: 'IMP-100-S',
      atex: true
    };

    const requirements: Partial<PumpRequirements> = {
      environment: 'ATEX'
    };

    const result = validateConfiguration(config, requirements);
    
    expect(result.isValid).toBe(false);
    // Should have at least one violation (voltage and/or HP)
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
  });

  test('should reject ATEX with CloseCoupled mount', () => {
    const config: Partial<PumpConfiguration> = {
      family: 'P100',
      motorHp: 5,
      voltage: '460V_3ph',
      sealType: 'Mechanical',
      material: 'Stainless',
      mount: 'CloseCoupled', // Wrong - should be Base
      impeller: 'IMP-120-M',
      atex: true
    };

    const requirements: Partial<PumpRequirements> = {
      environment: 'ATEX'
    };

    const result = validateConfiguration(config, requirements);
    
    expect(result.isValid).toBe(false);
    expect(result.violations.some(v => v.includes('ATEX'))).toBe(true);
  });

  test('should reject ATEX with insufficient motor HP', () => {
    const config: Partial<PumpConfiguration> = {
      family: 'P100',
      motorHp: 3, // Wrong - should be >= 5
      voltage: '460V_3ph',
      sealType: 'Mechanical',
      material: 'Stainless',
      mount: 'Base',
      impeller: 'IMP-100-S',
      atex: true
    };

    const requirements: Partial<PumpRequirements> = {
      environment: 'ATEX'
    };

    const result = validateConfiguration(config, requirements);
    
    expect(result.isValid).toBe(false);
    // Should have violations for both 460V with HP<5 and ATEX requirements
    expect(result.violations.length).toBeGreaterThan(1);
  });

  test('should validate configuration with exact boundary values', () => {
    // Test 230V with exactly 3 HP (boundary)
    const config1: Partial<PumpConfiguration> = {
      family: 'P100',
      motorHp: 3,
      voltage: '230V_1ph',
      sealType: 'Packing',
      material: 'CastIron',
      mount: 'CloseCoupled',
      impeller: 'IMP-100-S',
      atex: false
    };

    const result1 = validateConfiguration(config1, { environment: 'non-ATEX' });
    expect(result1.isValid).toBe(true);

    // Test 460V with exactly 5 HP (boundary)
    const config2: Partial<PumpConfiguration> = {
      family: 'P100',
      motorHp: 5,
      voltage: '460V_3ph',
      sealType: 'Mechanical',
      material: 'CastIron',
      mount: 'CloseCoupled',
      impeller: 'IMP-120-M',
      atex: false
    };

    const result2 = validateConfiguration(config2, { environment: 'non-ATEX' });
    expect(result2.isValid).toBe(true);

    // Test CloseCoupled with exactly 7.5 HP (boundary)
    const config3: Partial<PumpConfiguration> = {
      family: 'P200',
      motorHp: 7.5,
      voltage: '460V_3ph',
      sealType: 'Mechanical',
      material: 'CastIron',
      mount: 'CloseCoupled',
      impeller: 'IMP-140-L',
      atex: false
    };

    const result3 = validateConfiguration(config3, { environment: 'non-ATEX' });
    expect(result3.isValid).toBe(true);
  });

  test('should provide helpful suggestion when invalid', () => {
    const config: Partial<PumpConfiguration> = {
      family: 'P100',
      motorHp: 5,
      voltage: '230V_1ph', // Invalid combination
      sealType: 'Mechanical',
      material: 'CastIron',
      mount: 'CloseCoupled'
    };

    const result = validateConfiguration(config, { environment: 'non-ATEX' });
    
    expect(result.isValid).toBe(false);
    expect(result.suggestion).toBeDefined();
    expect(result.suggestion).toContain('adjust');
  });
});
