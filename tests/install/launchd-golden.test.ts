import { describe, expect, test } from 'bun:test';
import { launchdBackend } from '../../src/install/launchd-backend.ts';
import { cronToCalendarIntervals } from '../../src/install/common.ts';

/**
 * Test de oro del plist: el backend de systemd no puede cambiar nada en
 * macOS. El literal de abajo se generó con `renderPlist(buildPlistSpec(…))`
 * ANTES de mover launchd detrás de `SchedulerBackend`, y no se toca: si este
 * test falla, el plist que se escribe en los Mac ha cambiado, y eso no es un
 * refactor.
 */
const EXPECTED_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<!--',
  '  GENERADO POR `pipelines install` — NO EDITAR A MANO.',
  '  Origen:    /repo with space/pipelines/demo/pipeline.yaml',
  '  Generado:  2026-10-27T10:00:00.000Z',
  '',
  '  Para cambiar la cadencia, edita `triggers.cron` en ese fichero y vuelve a',
  '  ejecutar `pipelines install`. Para cambiar un parámetro, edita',
  '  `.params.local.json` en el repo de datos: este plist no lleva ninguno.',
  '-->',
  '<plist version="1.0">',
  '<dict>',
  '\t<key>Label</key>',
  '\t<string>cat.start.pipelines.demo</string>',
  '',
  '\t<key>ProgramArguments</key>',
  '\t<array>',
  '\t\t<string>/usr/local/bin/bun</string>',
  '\t\t<string>run</string>',
  '\t\t<string>/motor/src/cli/index.ts</string>',
  '\t\t<string>--repo</string>',
  '\t\t<string>/repo with space</string>',
  '\t\t<string>run</string>',
  '\t\t<string>demo</string>',
  '\t</array>',
  '',
  '\t<key>EnvironmentVariables</key>',
  '\t<dict>',
  '\t\t<key>PATH</key>',
  '\t\t<string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
  '\t\t<key>HOME</key>',
  '\t\t<string>/Users/x</string>',
  '\t</dict>',
  '',
  '\t<key>StartCalendarInterval</key>',
  '\t<array>',
  '\t\t<dict>',
  '\t\t\t<key>Minute</key>',
  '\t\t\t<integer>0</integer>',
  '\t\t\t<key>Hour</key>',
  '\t\t\t<integer>3</integer>',
  '\t\t</dict>',
  '\t\t<dict>',
  '\t\t\t<key>Minute</key>',
  '\t\t\t<integer>30</integer>',
  '\t\t\t<key>Hour</key>',
  '\t\t\t<integer>9</integer>',
  '\t\t\t<key>Weekday</key>',
  '\t\t\t<integer>1</integer>',
  '\t\t</dict>',
  '\t</array>',
  '',
  '\t<key>StandardOutPath</key>',
  '\t<string>/Users/x/Library/Logs/pipelines-demo.log</string>',
  '\t<key>StandardErrorPath</key>',
  '\t<string>/Users/x/Library/Logs/pipelines-demo.log</string>',
  '',
  '\t<key>RunAtLoad</key>',
  '\t<true/>',
  '</dict>',
  '</plist>',
  '',
].join('\n');

describe('launchdBackend.jobFiles', () => {
  test('genera el mismo plist, byte a byte, que antes de la interfaz', () => {
    const files = launchdBackend.jobFiles({
      pipelineName: 'demo',
      repoRoot: '/repo with space',
      bunPath: '/usr/local/bin/bun',
      cliEntry: '/motor/src/cli/index.ts',
      home: '/Users/x',
      path: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      calendarIntervals: [
        ...cronToCalendarIntervals('0 3 * * *'),
        ...cronToCalendarIntervals('30 9 * * 1'),
      ],
      generatedAt: '2026-10-27T10:00:00.000Z',
      guards: [{ throttle: '46h' }],
    });
    expect(files).toEqual([
      {
        path: '/Users/x/Library/LaunchAgents/cat.start.pipelines.demo.plist',
        contents: EXPECTED_PLIST,
      },
    ]);
  });
});
