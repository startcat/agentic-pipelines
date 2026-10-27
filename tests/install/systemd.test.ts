import { describe, expect, test } from 'bun:test';
import type { JobSpecInput } from '../../src/install/backend.ts';
import {
  onCalendarLines,
  renderServiceUnit,
  renderTimerUnit,
  systemdJobFiles,
  systemdLogPath,
  systemdQuote,
  userUnitDir,
} from '../../src/install/systemd.ts';

const input: JobSpecInput = {
  pipelineName: 'demo',
  repoRoot: '/srv/datos con espacio',
  bunPath: '/home/x/.bun/bin/bun',
  cliEntry: '/opt/engine/src/cli/index.ts',
  home: '/home/x',
  path: '/home/x/.bun/bin:/usr/bin:/bin',
  calendarIntervals: [{ Minute: 0, Hour: 10, Weekday: 1 }],
  generatedAt: '2026-10-27T10:00:00Z',
  guards: [],
};
const log = '/home/x/.local/state/pipelines/logs/pipelines-demo.log';

describe('onCalendarLines', () => {
  test('semanal, diario, mensual y cada minuto', () => {
    expect(onCalendarLines([{ Minute: 0, Hour: 10, Weekday: 1 }])).toEqual(['Mon *-*-* 10:00:00']);
    expect(onCalendarLines([{ Minute: 30, Hour: 3 }])).toEqual(['*-*-* 03:30:00']);
    expect(onCalendarLines([{ Minute: 0, Hour: 8, Day: 1 }])).toEqual(['*-*-01 08:00:00']);
    expect(onCalendarLines([{}])).toEqual(['*-*-* *:*:00']);
    expect(onCalendarLines([{ Weekday: 0, Hour: 9, Minute: 0 }])).toEqual(['Sun *-*-* 09:00:00']);
  });

  test('día del mes Y día de la semana son un OR, como en cron', () => {
    expect(onCalendarLines([{ Minute: 0, Hour: 8, Day: 1, Weekday: 1 }])).toEqual([
      '*-*-01 08:00:00',
      'Mon *-*-* 08:00:00',
    ]);
  });

  test('el mes se escribe en la fecha', () => {
    expect(onCalendarLines([{ Minute: 5, Hour: 6, Day: 2, Month: 3 }])).toEqual(['*-03-02 06:05:00']);
  });

  test('quita duplicados exactos conservando el orden', () => {
    expect(
      onCalendarLines([{ Minute: 0, Hour: 3 }, { Minute: 0, Hour: 4 }, { Minute: 0, Hour: 3 }]),
    ).toEqual(['*-*-* 03:00:00', '*-*-* 04:00:00']);
  });
});

describe('systemdQuote', () => {
  test('comillas, barra y porcentaje', () => {
    expect(systemdQuote('a b')).toBe('"a b"');
    expect(systemdQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(systemdQuote('100%')).toBe('"100%%"');
  });
});

describe('rutas', () => {
  test('userUnitDir', () => {
    expect(userUnitDir('/home/x', {})).toBe('/home/x/.config/systemd/user');
    expect(userUnitDir('/home/x', { XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/systemd/user');
  });
  test('systemdLogPath', () => {
    expect(systemdLogPath('/home/x', 'demo', {})).toBe(log);
    expect(systemdLogPath('/home/x', 'demo', { XDG_STATE_HOME: '/st' })).toBe(
      '/st/pipelines/logs/pipelines-demo.log',
    );
  });
});

describe('renderServiceUnit', () => {
  const unit = renderServiceUnit(input, log);

  test('cabecera', () => {
    expect(unit).toContain(
      '# Generado por `pipelines install` desde /srv/datos con espacio/pipelines/demo/pipeline.yaml\n' +
        '# Generado: 2026-10-27T10:00:00Z\n' +
        '# No editar a mano: se regenera con `pipelines install demo`.\n',
    );
  });

  test('ExecStart con todos los argumentos entrecomillados', () => {
    expect(unit).toContain(
      'ExecStart="/home/x/.bun/bin/bun" "run" "/opt/engine/src/cli/index.ts" "--repo" "/srv/datos con espacio" "run" "demo"',
    );
  });

  test('oneshot, entorno y logs', () => {
    expect(unit).toContain('Description=agentic-pipelines: demo\n');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('Environment="PATH=/home/x/.bun/bin:/usr/bin:/bin"');
    expect(unit).toContain('Environment="HOME=/home/x"');
    expect(unit).toContain(`StandardOutput=append:${log}`);
    expect(unit).toContain(`StandardError=append:${log}`);
    expect(unit).not.toContain('LANG');
    expect(unit).not.toContain('LC_ALL');
    expect(unit).not.toContain('[Install]');
  });

  test('% en repoRoot sale como %%', () => {
    expect(renderServiceUnit({ ...input, repoRoot: '/srv/50%' }, log)).toContain('"/srv/50%%"');
  });

  test('$ en repoRoot sale como $$ en ExecStart, pero no en Environment', () => {
    const unit = renderServiceUnit({ ...input, repoRoot: '/srv/a$HOME', path: '/bin:$x' }, log);
    expect(unit).toContain('"--repo" "/srv/a$$HOME"');
    expect(unit).toContain('Environment="PATH=/bin:$x"');
  });

  test('% en el log se duplica sin comillas', () => {
    expect(renderServiceUnit(input, '/h/50%/x.log')).toContain('StandardOutput=append:/h/50%%/x.log');
  });

  test('un log con espacios es un error claro', () => {
    expect(() => renderServiceUnit(input, '/h/con espacio/x.log')).toThrow(/espacios/);
  });
});

describe('renderTimerUnit', () => {
  test('una línea OnCalendar por horario, Unit e Install', () => {
    const timer = renderTimerUnit({
      ...input,
      calendarIntervals: [{ Minute: 0, Hour: 8, Day: 1, Weekday: 1 }],
    });
    expect(timer).toContain('# Generado: 2026-10-27T10:00:00Z\n');
    expect(timer).toContain('Description=agentic-pipelines: demo (horario)');
    expect(timer).toContain('OnCalendar=*-*-01 08:00:00\nOnCalendar=Mon *-*-* 08:00:00\n');
    expect(timer).toContain('Unit=cat.start.pipelines.demo.service');
    expect(timer).toContain('[Install]\nWantedBy=timers.target');
  });

  test('Persistent=true solo con guarda throttle', () => {
    expect(renderTimerUnit(input)).not.toContain('Persistent');
    const guards = [{ throttle: { every: '1d' } }] as unknown as JobSpecInput['guards'];
    expect(renderTimerUnit({ ...input, guards })).toContain('Persistent=true');
  });
});

describe('systemdJobFiles', () => {
  test('service y timer, en ese orden', () => {
    const files = systemdJobFiles(input, {});
    expect(files.map((f) => f.path)).toEqual([
      '/home/x/.config/systemd/user/cat.start.pipelines.demo.service',
      '/home/x/.config/systemd/user/cat.start.pipelines.demo.timer',
    ]);
    expect(files[0]!.contents).toContain(`StandardOutput=append:${log}`);
    expect(files[1]!.contents).toContain('[Timer]');
  });
  test('respeta XDG_CONFIG_HOME', () => {
    expect(systemdJobFiles(input, { XDG_CONFIG_HOME: '/cfg' })[0]!.path).toBe(
      '/cfg/systemd/user/cat.start.pipelines.demo.service',
    );
  });
});
