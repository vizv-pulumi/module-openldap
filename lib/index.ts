import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import * as certmanager from '@vizv/crds-cert-manager'
import * as random from '@vizv/provider-random'
import { heredoc } from '@vizv/pulumi-utilities'

export interface OpenldapArgs {
  namespaceName: pulumi.Input<string>
  baseDomain: pulumi.Input<string>
  organizationName: pulumi.Input<string>
  ldapIp: pulumi.Input<string>
  usersOrganizationUnit?: pulumi.Input<string>
  applicationsOrganizationUnit?: pulumi.Input<string>
}

export class Openldap extends pulumi.ComponentResource {
  private readonly args: OpenldapArgs

  public readonly caCertificate: certmanager.v1.Certificate
  public readonly issuer: certmanager.v1.Issuer
  public readonly certificate: certmanager.v1.Certificate
  public readonly configMap: k8s.core.v1.ConfigMap
  public readonly files: k8s.core.v1.ConfigMap
  public readonly scripts: k8s.core.v1.ConfigMap
  public readonly token: random.RandomString
  public readonly secret: k8s.core.v1.Secret
  public readonly statefulSet: k8s.apps.v1.StatefulSet
  public readonly service: k8s.core.v1.Service

  constructor(
    name: string,
    args: OpenldapArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super('vizv:module:Openldap', name, {}, opts)
    this.args = args

    const dependsOnOutput = pulumi.output(opts?.dependsOn || [])
    const dependencies = dependsOnOutput.apply((dependsOn) =>
      Array.isArray(dependsOn) ? dependsOn : [dependsOn],
    )

    this.caCertificate = new certmanager.v1.Certificate(
      `${name}-ca`,
      {
        metadata: {
          name: `${name}-ca`,
          namespace: args.namespaceName,
        },
        spec: {
          isCA: true,
          commonName: `${
            args.organizationName
          } Self-signed CA - ${pulumi.getStack()}`,
          secretName: 'ca-tls',
          privateKey: {
            algorithm: 'ECDSA',
            size: 384,
          },
          issuerRef: {
            kind: 'ClusterIssuer',
            name: 'selfsigned',
          },
        },
      },
      {
        parent: this,
        protect: opts?.protect,
      },
    )

    this.issuer = new certmanager.v1.Issuer(
      `${name}-ca`,
      {
        metadata: {
          name: `${name}-ca`,
          namespace: args.namespaceName,
        },
        spec: {
          ca: {
            secretName: this.caCertificate.spec.secretName,
          },
        },
      },
      {
        parent: this,
        protect: opts?.protect,
        dependsOn: this.caCertificate,
      },
    )

    this.certificate = new certmanager.v1.Certificate(
      name,
      {
        metadata: {
          name,
          namespace: args.namespaceName,
        },
        spec: {
          commonName: this.hostname,
          secretName: 'ldap-tls',
          issuerRef: {
            name: pulumi.output(
              this.issuer.metadata.apply((metadata) => metadata!.name!),
            ),
          },
          privateKey: {
            algorithm: 'ECDSA',
            size: 384,
          },
        },
      },
      {
        parent: this,
        protect: opts?.protect,
        dependsOn: this.issuer,
      },
    )

    this.configMap = new k8s.core.v1.ConfigMap(
      name,
      {
        metadata: {
          name,
          namespace: args.namespaceName,
        },
        data: {
          LDAP_ORGANISATION: args.organizationName,
          LDAP_DOMAIN: args.baseDomain,
          LDAP_LOG_LEVEL: '32768',
        },
      },
      {
        parent: this,
        protect: opts?.protect,
      },
    )

    this.files = new k8s.core.v1.ConfigMap(
      `${name}-files`,
      {
        metadata: {
          name: `${name}-files`,
          namespace: args.namespaceName,
        },
        data: {
          '50-ou-users.ldif': heredoc`
            dn: ${this.usersOu}
            objectClass: organizationalunit
            ou: ${this.usersOrganizationUnit}
            description: ${this.usersOrganizationUnit}
          `,
          '50-ou-applications.ldif': heredoc`
            dn: ${this.applicationsOu}
            objectClass: organizationalunit
            ou: ${this.applicationsOrganizationUnit}
            description: ${this.applicationsOrganizationUnit}
          `,
        },
      },
      {
        parent: this,
        protect: opts?.protect,
      },
    )

    const certsMount = '/certs'
    const certsPath = '/container/service/slapd/assets/certs'
    const filesMount = '/files'
    const customBootstrapPath =
      '/container/service/slapd/assets/config/bootstrap/ldif/custom'
    const startupPath = '/container/service/:copy-certs'

    this.scripts = new k8s.core.v1.ConfigMap(
      `${name}-scripts`,
      {
        metadata: {
          name: `${name}-scripts`,
          namespace: args.namespaceName,
        },
        data: {
          'startup.sh': heredoc`
            #!/bin/bash -ex
            cp -Lv "${certsMount}"/* "${certsPath}/"
            cp -Lv "${filesMount}"/*.ldif "${customBootstrapPath}/"
          `,
        },
      },
      {
        parent: this,
        protect: opts?.protect,
      },
    )

    this.token = new random.RandomString(
      name,
      {},
      {
        parent: this,
        protect: opts?.protect,
      },
    )

    this.secret = new k8s.core.v1.Secret(
      name,
      {
        metadata: {
          name,
          namespace: args.namespaceName,
        },
        stringData: {
          LDAP_ADMIN_PASSWORD: this.token.secret,
          LDAP_CONFIG_PASSWORD: this.token.secret,
        },
      },
      {
        parent: this,
        protect: opts?.protect,
        dependsOn: this.token,
      },
    )

    const ldapProbe: k8s.types.input.core.v1.Probe = {
      exec: {
        command: [
          'bash',
          '-c',
          pulumi.interpolate`[ "$(ldapwhoami -D'${this.adminDn}' -w"$LDAP_ADMIN_PASSWORD" 2>&1)" = 'dn:${this.adminDn}' ]`,
        ],
      },
    }

    this.statefulSet = new k8s.apps.v1.StatefulSet(
      name,
      {
        metadata: {
          name,
          namespace: args.namespaceName,
        },
        spec: {
          podManagementPolicy: 'Parallel',
          serviceName: name,
          selector: {
            matchLabels: {
              app: name,
            },
          },
          template: {
            metadata: {
              labels: {
                app: name,
              },
            },
            spec: {
              containers: [
                {
                  name,
                  image: 'osixia/openldap:latest',
                  ports: [
                    {
                      name: 'ldap',
                      containerPort: 389,
                    },
                    {
                      name: 'ldaps',
                      containerPort: 636,
                    },
                  ],
                  volumeMounts: [
                    ...['/var/lib/ldap', '/etc/ldap/slapd.d', certsPath].map(
                      (path) => ({
                        name,
                        mountPath: path,
                        subPath: path.substr(1),
                      }),
                    ),
                    {
                      name: 'certs',
                      mountPath: certsMount,
                      readOnly: true,
                    },
                    {
                      name: 'files',
                      mountPath: filesMount,
                      readOnly: true,
                    },
                    {
                      name: 'scripts',
                      mountPath: startupPath,
                      readOnly: true,
                    },
                  ],
                  envFrom: [
                    {
                      configMapRef: {
                        name: this.configMap.metadata.name,
                      },
                    },
                    {
                      secretRef: {
                        name: this.secret.metadata.name,
                      },
                    },
                  ],
                  startupProbe: ldapProbe,
                  readinessProbe: ldapProbe,
                  livenessProbe: ldapProbe,
                },
              ],
              volumes: [
                {
                  name: 'certs',
                  secret: {
                    secretName: this.certificate.spec.secretName,
                    items: [
                      {
                        key: 'tls.crt',
                        path: 'ldap.crt',
                      },
                      {
                        key: 'tls.key',
                        path: 'ldap.key',
                      },
                      {
                        key: 'ca.crt',
                        path: 'ca.crt',
                      },
                    ],
                  },
                },
                {
                  name: 'files',
                  configMap: {
                    name: this.files.metadata.name,
                  },
                },
                {
                  name: 'scripts',
                  configMap: {
                    name: this.scripts.metadata.name,
                    defaultMode: 0o755,
                  },
                },
              ],
              hostname: this.hostname,
              enableServiceLinks: false,
            },
          },
          volumeClaimTemplates: [
            {
              metadata: {
                name,
              },
              spec: {
                accessModes: ['ReadWriteOnce'],
                resources: {
                  requests: {
                    storage: '1G',
                  },
                },
              },
            },
          ],
        },
      },
      {
        parent: this,
        protect: opts?.protect,
        dependsOn: dependencies.apply((dependsOn) => [
          ...dependsOn,
          this.configMap,
          this.secret,
          this.files,
          this.scripts,
        ]),
      },
    )

    this.service = new k8s.core.v1.Service(
      name,
      {
        metadata: {
          name,
          namespace: args.namespaceName,
          annotations: {
            'metallb.universe.tf/allow-shared-ip': args.ldapIp,
          },
        },
        spec: {
          type: 'LoadBalancer',
          selector: {
            app: name,
          },
          loadBalancerIP: args.ldapIp,
          ports: [
            {
              name: 'ldap',
              port: 389,
            },
            {
              name: 'ldaps',
              port: 636,
            },
          ],
        },
      },
      {
        parent: this,
        protect: opts?.protect,
        dependsOn: this.statefulSet,
      },
    )
  }

  get hostname() {
    return pulumi.interpolate`ldap.${this.args.baseDomain}`
  }

  get baseDn() {
    return pulumi.output(this.args.baseDomain).apply((baseDomain) =>
      baseDomain
        .split('.')
        .map((dc) => `dc=${dc}`)
        .join(','),
    )
  }

  get adminDn() {
    return pulumi.interpolate`cn=admin,${this.baseDn}`
  }

  get usersOrganizationUnit() {
    return this.args.usersOrganizationUnit || 'Users'
  }

  get usersOu() {
    return pulumi
      .all([this.usersOrganizationUnit, this.baseDn])
      .apply(([ou, baseDn]) => `ou=${ou},${baseDn}`)
  }

  get applicationsOrganizationUnit() {
    return this.args.applicationsOrganizationUnit || 'Applications'
  }

  get applicationsOu() {
    return pulumi
      .all([this.applicationsOrganizationUnit, this.baseDn])
      .apply(([ou, baseDn]) => `ou=${ou},${baseDn}`)
  }

  get password() {
    return this.token.secret
  }
}
