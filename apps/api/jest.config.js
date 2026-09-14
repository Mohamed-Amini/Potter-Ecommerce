export default {
  testEnvironment: 'node',
  passWithNoTests: true,
  transform: {
    '^.+\\.ts$': '@swc/jest',
  },
  testMatch: ['<rootDir>/src/**/*.(spec|test).ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@pottery/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@pottery/shared/(.*)$': '<rootDir>/../../packages/shared/src/$1',
  },
};
