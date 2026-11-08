import type { FusionProvider } from '../types.ts';
import { MockProvider } from './mock.ts';

// Providers are loaded by name from AI_PROVIDER. Adding one means adding a file
// that implements FusionProvider and a case here; nothing else changes.
export async function createProvider(name: string, env: NodeJS.ProcessEnv = process.env): Promise<FusionProvider> {
  switch (name) {
    case 'mock':
      return new MockProvider();
    case 'anthropic': {
      const { AnthropicProvider } = await import('./anthropic.ts');
      return new AnthropicProvider(env);
    }
    default:
      throw new Error(`Unknown AI_PROVIDER "${name}"`);
  }
}
