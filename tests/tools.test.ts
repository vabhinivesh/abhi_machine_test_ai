import { describe, test, expect, beforeAll } from '@jest/globals';
import { validateConfiguration, calculatePricing } from '../src/agent/tools';
import { PumpConfiguration, PumpRequirements } from '../src/models/types';

describe('CPQ Agent Tools', () => {
  describe('validateConfiguration', () => {
    test('should validate a correct configuration', () => {
      const config: Partial<PumpConfiguration> = {
        family: 'P100',
        motorHp: 5,
        voltage: '460V_3ph',
        sealType: 'Mechanical',
        material: 'CastIron',
        mount: 'CloseCoupled',
        impeller: 'IMP-120-M',
        atex: false
      };

      const requirements: Partial<PumpRequirements> = {
        gpm: 75,
        headFt: 100,
        environment: 'non-ATEX'
      };

      const result = validateConfiguration(config, requirements);
      expect(result.isValid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    test('should reject 230V with motor HP > 3', () => {
      const config: Partial<PumpConfiguration> = {
        family: 'P100',
        motorHp: 5,
        voltage: '230V_1ph',
        sealType: 'Mechanical',
        material: 'CastIron',
        mount: 'CloseCoupled'
      };

      const requirements: Partial<PumpRequirements> = {
        environment: 'non-ATEX'
      };

      const result = validateConfiguration(config, requirements);
      expect(result.isValid).toBe(false);
      expect(result.violations).toContain('230V 1-phase requires Motor HP <= 3');
    });

    test('should reject 460V with motor HP < 5', () => {
      const config: Partial<PumpConfiguration> = {
        family: 'P100',
        motorHp: 3,
        voltage: '460V_3ph',
        sealType: 'Mechanical',
        material: 'CastIron',
        mount: 'CloseCoupled'
      };

      const requirements: Partial<PumpRequirements> = {
        environment: 'non-ATEX'
      };

      const result = validateConfiguration(config, requirements);
      expect(result.isValid).toBe(false);
      expect(result.violations).toContain('460V 3-phase requires Motor HP >= 5');
    });

    test('should reject close-coupled mount with motor HP > 7.5', () => {
      const config: Partial<PumpConfiguration> = {
        family: 'P200',
        motorHp: 10,
        voltage: '460V_3ph',
        sealType: 'Mechanical',
        material: 'CastIron',
        mount: 'CloseCoupled'
      };

      const requirements: Partial<PumpRequirements> = {
        environment: 'non-ATEX'
      };

      const result = validateConfiguration(config, requirements);
      expect(result.isValid).toBe(false);
      expect(result.violations).toContain('Close coupled mount requires Motor HP <= 7.5');
    });

    test('should validate ATEX configuration', () => {
      const config: Partial<PumpConfiguration> = {
        family: 'P200',
        motorHp: 10,
        voltage: '460V_3ph',
        sealType: 'Mechanical',
        material: 'Stainless',
        mount: 'Base',
        impeller: 'IMP-180-XL',
        atex: true
      };

      const requirements: Partial<PumpRequirements> = {
        environment: 'ATEX'
      };

      const result = validateConfiguration(config, requirements);
      expect(result.isValid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe('calculatePricing', () => {
    test('should calculate pricing for a basic configuration', () => {
      const config: PumpConfiguration = {
        family: 'P100',
        motorHp: 3,
        voltage: '230V_1ph',
        sealType: 'Packing',
        material: 'CastIron',
        mount: 'CloseCoupled',
        impeller: 'IMP-100-S',
        atex: false
      };

      const pricing = calculatePricing(config, 20);

      expect(pricing.discountPercent).toBe(20);
      expect(pricing.listTotal).toBeGreaterThan(0);
      expect(pricing.netTotal).toBeLessThan(pricing.listTotal);
      expect(pricing.netTotal).toBe(pricing.listTotal * 0.8); // 20% discount
      expect(pricing.bom).toBeDefined();
      expect(pricing.bom!.length).toBeGreaterThan(0);
    });

    test('should include ATEX package in pricing when required', () => {
      const config: PumpConfiguration = {
        family: 'P200',
        motorHp: 10,
        voltage: '460V_3ph',
        sealType: 'Mechanical',
        material: 'Stainless',
        mount: 'Base',
        impeller: 'IMP-180-XL',
        atex: true
      };

      const pricing = calculatePricing(config, 20);

      expect(pricing.bom).toBeDefined();
      const atexItem = pricing.bom!.find(item => item.sku === 'ATEX-PKG');
      expect(atexItem).toBeDefined();
      expect(atexItem!.unitPrice).toBe(1000);
    });

    test('should apply custom discount percentage', () => {
      const config: PumpConfiguration = {
        family: 'P100',
        motorHp: 5,
        voltage: '460V_3ph',
        sealType: 'Mechanical',
        material: 'CastIron',
        mount: 'CloseCoupled',
        impeller: 'IMP-120-M',
        atex: false
      };

      const pricing = calculatePricing(config, 15);

      expect(pricing.discountPercent).toBe(15);
      expect(pricing.netTotal).toBe(pricing.listTotal * 0.85); // 15% discount
    });
  });
});
