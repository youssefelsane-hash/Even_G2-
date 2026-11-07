import type { Answer } from './core/assistant.ts';

let counter = 0;

/** Stand-in for the AI backend, long enough to need scrolling. */
export function sampleAnswer(): Answer {
  counter++;
  return {
    id: `fake-${counter}`,
    short: `Sample answer ${counter}: photosynthesis turns light, water and carbon dioxide into sugar and oxygen.`,
    details: [
      'Details',
      'Light is absorbed by chlorophyll inside the chloroplasts of a plant cell.',
      'In the light reactions, water is split. This releases oxygen and stores energy in ATP and NADPH.',
      'In the Calvin cycle, that stored energy is used to build sugar from carbon dioxide.',
      'The overall equation is: 6 CO2 + 6 H2O + light gives C6H12O6 + 6 O2.',
      'The rate depends on light intensity, carbon dioxide level and temperature.',
      'If any one of these is low, it limits the whole process. This is called a limiting factor.',
      'Plants use the sugar for energy and for building cellulose, which forms cell walls.',
      'End of the sample answer.',
    ].join('\n'),
  };
}
