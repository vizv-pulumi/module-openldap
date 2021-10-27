import * as pulumi from '@pulumi/pulumi'
import { Openldap } from './lib'

const config = new pulumi.Config()

const resource = new Openldap('openldap', {
  namespaceName: config.get('namespaceName') || 'default',
  baseDomain: config.require('baseDomain'),
  organizationName: config.get('organizationName') || 'OpenLDAP Test Stack',
  ldapIp: config.require('ldapIp'),
  usersOrganizationUnit: config.get('usersOrganizationUnit'),
  applicationsOrganizationUnit: config.get('applicationsOrganizationUnit'),
})

export const password = resource.password
