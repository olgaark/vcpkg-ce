// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { fail } from 'assert';
import { resolve } from 'path';
import { MetadataFile } from '../amf/metadata-file';
import { i } from '../i18n';
import { activateEspIdf } from '../installers/espidf';
import { InstallEvents } from '../interfaces/events';
import { Registries } from '../registries/registries';
import { Session } from '../session';
import { linq } from '../util/linq';
import { Uri } from '../util/uri';
import { Activation } from './activation';
import { SetOfDemands } from './SetOfDemands';

export type Selections = Map<string, string>;
export type UID = string;
export type ID = string;
export type VersionRange = string;
export type Selection = [Artifact, ID, VersionRange]

export class ArtifactMap extends Map<UID, Selection>{
  get artifacts() {
    return [...linq.values(this).select(([artifact, id, range]) => artifact)].sort((a, b) => (b.metadata.info.priority || 0) - (a.metadata.info.priority || 0));
  }
}

class ArtifactBase {
  public registries: Registries;
  readonly applicableDemands: SetOfDemands;

  constructor(protected session: Session, public readonly metadata: MetadataFile) {
    this.applicableDemands = new SetOfDemands(this.metadata, this.session);
    this.registries = new Registries(session);

    // load the registries from the project file
    for (const [name, registry] of this.metadata.registries) {
      const reg = session.loadRegistry(registry.location.get(0), registry.registryKind || 'artifact');
      if (reg) {
        this.registries.add(reg, name);
      }
    }
  }

  /** Async Initializer */
  async init(session: Session) {
    await this.applicableDemands.init(session);
    return this;
  }

  async resolveDependencies(artifacts = new ArtifactMap(), recurse = true) {
    // find the dependencies and add them to the set
    for (const [id, version] of linq.entries(this.applicableDemands.requires)) {
      if (id.indexOf(':') === -1) {
        throw new Error(`Dependency '${id}' version '${version.raw}' does not specify the registry.`);
      }
      const dep = await this.registries.getArtifact(id, version.raw);
      if (!dep) {
        throw new Error(`Unable to resolve dependency ${id}/${version}`);
      }
      const artifact = dep[2];
      if (!artifacts.has(artifact.uniqueId)) {
        artifacts.set(artifact.uniqueId, [artifact, id, version.raw || '*']);

        if (recurse) {
          // process it's dependencies too.
          await artifact.resolveDependencies(artifacts);
        }
      }
    }

    // special case for git
    if (!artifacts.has('microsoft:tools/git')) {
      // check if anyone needs git and add it if it isn't there
      for (const each of this.applicableDemands.installer) {
        if (each.installerKind === 'git') {
          const [reg, id, art] = await this.registries.getArtifact('microsoft:tools/git', '*') || [];
          if (art) {
            artifacts.set('microsoft:tools/git', [art, 'microsoft:tools/git', '*']);
            break;
          }
        }
      }
    }

    return artifacts;
  }

}

export class Artifact extends ArtifactBase {
  isPrimary = false;

  constructor(session: Session, metadata: MetadataFile, public shortName: string = '', protected targetLocation: Uri, public readonly registryId: string, public readonly registryUri: Uri) {
    super(session, metadata);
  }

  get id() {
    return this.metadata.info.id;
  }

  get reference() {
    return `${this.registryId}:${this.id}`;
  }

  get version() {
    return this.metadata.info.version;
  }

  get isInstalled() {
    return this.targetLocation.exists('artifact.yaml');
  }

  get uniqueId() {
    return `${this.registryUri.toString()}::${this.id}::${this.version}`;
  }

  async install(activation: Activation, events: Partial<InstallEvents>, options: { force?: boolean, allLanguages?: boolean, language?: string }): Promise<boolean> {

    // is it installed?
    if (await this.isInstalled && !options.force) {
      await this.loadActivationSettings(activation);
      return false;
    }

    if (options.force) {
      try {
        await this.uninstall();
      } catch {
        // if a file is locked, it may not get removed. We'll deal with this later.
      }
    }
    const applicableDemands = this.applicableDemands;

    let isFailing = false;
    for (const error of applicableDemands.errors) {
      this.session.channels.error(error);
      isFailing = true;
    }

    if (isFailing) {
      throw Error('errors present');
    }

    // warnings
    for (const warning of applicableDemands.warnings) {
      this.session.channels.warning(warning);
    }

    // messages
    for (const message of applicableDemands.messages) {
      this.session.channels.message(message);
    }

    // ok, let's install this.
    for (const installInfo of applicableDemands.installer) {
      if (installInfo.lang && !options.allLanguages && options.language && options.language.toLowerCase() !== installInfo.lang.toLowerCase()) {
        continue;
      }

      const installer = this.session.artifactInstaller(installInfo);
      if (!installer) {
        fail(i`Unknown installer type ${installInfo!.installerKind}`);
      }

      await installer(this.session, activation, this.id, this.targetLocation, installInfo, events, options);

    }

    // after we unpack it, write out the installed manifest
    await this.writeManifest();

    return true;
  }

  get name() {
    return `${this.metadata.info.id.replace(/[^\w]+/g, '.')}-${this.metadata.info.version}`;
  }

  async writeManifest() {
    await this.targetLocation.createDirectory();
    await this.metadata.save(this.targetLocation.join('artifact.yaml'));
  }

  async uninstall() {
    await this.targetLocation.delete({ recursive: true, useTrash: false });
  }


  async loadActivationSettings(activation: Activation) {
    // construct paths (bin, lib, include, etc.)
    // construct tools
    // compose variables
    // defines

    // special case -- add activation settings for espidf if we're doing an espidf activation.
    if (this.metadata.info.flags.has('espidf')) {
      await activateEspIdf(this.session, this.targetLocation, activation);
    }

    const l = this.targetLocation.toString().length + 1;
    const allPaths = (await this.targetLocation.readDirectory(undefined, { recursive: true })).select(([name, stat]) => name.toString().substr(l));

    for (const settingBlock of this.applicableDemands.settings) {
      // **** defines ****
      // eslint-disable-next-line prefer-const
      for (let [key, value] of settingBlock.defines) {
        if (value === 'true') {
          value = '1';
        }

        const v = activation.defines.get(key);
        if (v && v !== value) {
          // conflict. todo: what do we want to do?
          this.session.channels.warning(i`Duplicate define ${key} during activation. New value will replace old `);
        }
        activation.defines.set(key, value);
      }

      // **** paths ****
      for (const key of settingBlock.paths.keys) {
        if (!key) {
          continue;
        }

        const pathEnvVariable = key.toUpperCase();
        const p = activation.paths.getOrDefault(pathEnvVariable, []);
        const l = settingBlock.paths.get(key);
        const uris = new Set<Uri>();

        for (const location of l ?? []) {
          // check that each path is an actual path.
          const path = await this.sanitizeAndValidatePath(location);
          if (path && !uris.has(path)) {
            uris.add(path);
            p.push(path);
          }
        }
      }

      // **** tools ****
      for (const key of settingBlock.tools.keys) {
        const envVariable = key.toUpperCase();

        if (activation.tools.has(envVariable)) {
          this.session.channels.error(i`Duplicate tool declared ${key} during activation. Probably not a good thing?`);
        }

        const p = settingBlock.tools.get(key) || '';
        const uri = await this.sanitizeAndValidatePath(p);
        if (uri) {
          activation.tools.set(envVariable, uri.fsPath);
        } else {
          if (p) {
            activation.tools.set(envVariable, p);
            // this.session.channels.warning(i`Invalid tool path '${p}'`);
          }
        }
      }

      // **** variables ****
      for (const [key, value] of settingBlock.variables) {
        const envKey = activation.environment.getOrDefault(key, []);
        envKey.push(...value);
      }

      // **** properties ****
      for (const [key, value] of settingBlock.properties) {
        const envKey = activation.properties.getOrDefault(key, []);
        envKey.push(...value);
      }

      // **** locations ****
      for (const locationName of settingBlock.locations.keys) {
        if (activation.locations.has(locationName)) {
          this.session.channels.error(i`Duplicate location declared ${locationName} during activation. Probably not a good thing?`);
        }

        const p = settingBlock.locations.get(locationName) || '';
        const uri = await this.sanitizeAndValidatePath(p);
        if (uri) {
          activation.locations.set(locationName, uri);
        }
      }
    }
  }

  async sanitizeAndValidatePath(path: string) {
    try {
      const loc = this.session.fileSystem.file(resolve(path));
      if (await loc.exists()) {
        return loc;
      }
    } catch {
      // no worries, treat it like a relative path.
    }
    const loc = this.targetLocation.join(sanitizePath(path));
    if (await loc.exists()) {
      return loc;
    }
    return undefined;
  }
}

export function sanitizePath(path: string) {
  return path.
    replace(/[\\/]+/g, '/').     // forward slahses please
    replace(/[?<>:|"]/g, ''). // remove illegal characters.
    // eslint-disable-next-line no-control-regex
    replace(/[\x00-\x1f\x80-\x9f]/g, ''). // remove unicode control codes
    replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i, ''). // no reserved names
    replace(/^[/.]*\//, ''). // dots and slashes off the front.
    replace(/[/.]+$/, ''). // dots and slashes off the back.
    replace(/\/\.+\//g, '/'). // no parts made just of dots.
    replace(/\/+/g, '/'); // duplicate slashes.
}

export function sanitizeUri(u: string) {
  return u.
    replace(/[\\/]+/g, '/').     // forward slahses please
    replace(/[?<>|"]/g, ''). // remove illegal characters.
    // eslint-disable-next-line no-control-regex
    replace(/[\x00-\x1f\x80-\x9f]/g, ''). // remove unicode control codes
    replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i, ''). // no reserved names
    replace(/^[/.]*\//, ''). // dots and slashes off the front.
    replace(/[/.]+$/, ''). // dots and slashes off the back.
    replace(/\/\.+\//g, '/'). // no parts made just of dots.
    replace(/\/+/g, '/'); // duplicate slashes.
}

export class ProjectManifest extends ArtifactBase {

}

export class InstalledArtifact extends Artifact {
  constructor(session: Session, metadata: MetadataFile) {
    super(session, metadata, '', Uri.invalid, 'OnDisk?', Uri.invalid); /* fixme ? */
  }
}