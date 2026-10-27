import { describe, expect, it } from 'vitest';
import { cyclePending, nextCycleAt } from '../src/admin.ts';

// Horário de São Paulo (UTC-3) em outubro de 2026: hora local + 3 = UTC (Date.UTC vira o dia quando passa de 24h).
const sp = (hhmm: string, day = 27) => new Date(Date.UTC(2026, 9, day, Number(hhmm.slice(0, 2)) + 3, Number(hhmm.slice(3))));

describe('próximo ciclo no painel (27/10)', () => {
  it('fora da janela de atraso, aponta a próxima hora cheia', () => {
    expect(nextCycleAt(sp('09:40'))).toBe('10:00');
    expect(nextCycleAt(sp('10:30'))).toBe('16:00');
    expect(nextCycleAt(sp('23:10'))).toBe('04:00');
  });

  it('dentro dos 15 min de atraso do timer, o ciclo ainda vai rodar', () => {
    // Caso real: 10:04, último ciclo às 09:33 (manual). O painel dizia "próximo ciclo 16:00".
    expect(cyclePending(sp('10:04'), sp('09:33'))).toBe('10:00');
    expect(cyclePending(sp('10:14'), sp('09:33'))).toBe('10:00');
  });

  it('depois que o ciclo da hora rodou, não há pendência', () => {
    expect(cyclePending(sp('10:13'), sp('10:11'))).toBeNull();
    expect(cyclePending(sp('10:16'), sp('09:33'))).toBeNull(); // passou da janela
    expect(cyclePending(sp('09:40'), sp('04:20'))).toBeNull(); // antes da hora cheia
  });

  it('último ciclo de ontem não conta como ciclo da hora de hoje', () => {
    expect(cyclePending(sp('04:05'), sp('22:30', 26))).toBe('04:00');
  });
});
