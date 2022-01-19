// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CloneOptions, Git } from '../archivers/git';
import { Activation } from '../artifacts/activation';
import { i } from '../i18n';
import { InstallEvents, InstallOptions } from '../interfaces/events';
import { CloneSettings, GitInstaller } from '../interfaces/metadata/installers/git';
import { Session } from '../session';
import { Uri } from '../util/uri';
import { installEspIdf } from './espidf';

export async function installGit(session: Session, activation: Activation, name: string, targetLocation: Uri, install: GitInstaller, events: Partial<InstallEvents>, options: Partial<InstallOptions & CloneOptions & CloneSettings>): Promise<void> {
  // clone the uri
  // save it to the cache
  const gitPath = activation.tools.get('GIT');
  if (!gitPath) {
    throw new Error(i`Git is not installed`);
  }

  const repo = session.parseUri(install.location);
  const targetDirectory = targetLocation.join(options.subdirectory ?? '');

  const gitTool = new Git(session, gitPath, activation.environmentBlock, targetDirectory);

  await gitTool.clone(repo, events, {
    recursive: install.recurse,
    depth: install.full ? undefined : 1,
  });

  if (install.commit) {
    if (install.full) {
      await gitTool.reset(events, {
        commit: install.commit,
        recurse: install.recurse,
        hard: true
      });
    }
    else {
      await gitTool.fetch('origin', events, {
        commit: install.commit,
        recursive: install.recurse,
        depth: install.full ? undefined : 1
      });
      await gitTool.checkout(events, {
        commit: install.commit
      });
    }
  }

  if (install.espidf) {
    await installEspIdf(targetDirectory, activation);
  }
}
