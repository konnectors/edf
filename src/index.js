const {
  CookieKonnector,
  log,
  solveCaptcha,
  errors
} = require('cozy-konnector-libs')
const qs = require('querystring')

class EdfConnector extends CookieKonnector {
  async authenticate(fields) {
    // I think it is needed
    this._jar._jar.setCookieSync('i18next=fr', 'edf.fr', {})

    // display the login form
    await this.request(
      'https://espace-client.edf.fr/sso/XUI/#login/Internet&authIndexType=service&authIndexValue=ldapservice'
    )
    // get authentication structure
    const auth = await this.request.post(
      'https://espace-client.edf.fr/sso/json/Internet/authenticate?authIndexType=service&authIndexValue=ldapservice'
    )

    const websiteKey = auth['callbacks'][4]['output'][0]['value']
    const websiteURL =
      'https://espace-client.edf.fr/sso/XUI/#login/Internet&authIndexType=service&authIndexValue=ldapservice'
    const captchaToken = await solveCaptcha({ websiteURL, websiteKey })

    auth['callbacks'][0]['input'][0]['value'] = fields.login
    auth['callbacks'][1]['input'][0]['value'] = fields.password
    auth['callbacks'][2]['input'][0]['value'] = captchaToken
    auth['callbacks'][3]['input'][0]['value'] = '0'

    try {
      const { tokenId } = await this.request.post(
        'https://espace-client.edf.fr/sso/json/Internet/authenticate?authIndexType=service&authIndexValue=ldapservice',
        { body: auth }
      )
      this._jar._jar.setCookieSync(
        `ivoiream=${tokenId}`,
        'https://espace-client.edf.fr',
        {}
      )
    } catch (err) {
      // sometimes the session still works...
      if (!(await this.testSession())) {
        log('error', err.message)
        throw new Error(errors.LOGIN_FAILED)
      }
    }
  }

  async fetch(fields) {
    if (!(await this.testSession())) {
      log('info', 'Found no correct session, logging in...')
      await this.authenticate(fields)
      log('info', 'Successfully logged in')
    }

    const { id } = await this.request.post(
      'https://espace-client.edf.fr/sso/json/Internet/users?_action=idFromSession'
    )

    await this.request(
      `https://espace-client.edf.fr/sso/json/internet/users/${id}`
    )

    this.request = this.requestFactory({
      cheerio: true,
      json: false,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:65.0) Gecko/20100101 Firefox/65.0',
        'Accept-Language': 'fr',
        // 'Accept-Encoding': 'gzip, deflate, br',
        Referer: 'https://espace-client.edf.fr/sso/XUI/',
        'Accept-API-Version': 'protocol=1.0,resource=2.0'
      }
    })

    const valid$ = await this.request(
      'https://particulier.edf.fr/fr/accueil/espace-client/tableau-de-bord.html'
    )

    // sometimes edf return a form which we have to submit...
    if (valid$('body').attr('onload')) {
      const $form = valid$('form')
      await this.request.post($form.attr('action'), {
        form: getFormData($form)
      })
    }

    await this.request(
      'https://particulier.edf.fr/services/rest/openid/checkAuthenticate'
    )

    this.request = this.requestFactory({
      cheerio: false,
      json: true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:65.0) Gecko/20100101 Firefox/65.0',
        'Accept-Language': 'fr',
        Referer: 'https://espace-client.edf.fr/sso/XUI/',
        'Accept-API-Version': 'protocol=1.0,resource=2.0'
      }
    })

    await this.request(
      'https://particulier.edf.fr/services/rest/authenticate/getListContracts'
    )

    await this.request(
      'https://particulier.edf.fr/services/rest/edoc/getMyDocuments'
    )

    const attestationData = await this.request(
      `https://particulier.edf.fr/services/rest/edoc/getAttestationsContract?_=${Date.now()}`
    )
    const dataCsrfToken = await this.request(
      `https://particulier.edf.fr/services/rest/init/initPage?_=${Date.now()}`
    )
    const csrfToken = dataCsrfToken.data

    await this.saveFiles(
      [
        {
          requestOptions: {
            json: false
          },
          filename: 'attestation.pdf',
          fileurl:
            'https://particulier.edf.fr/services/rest/document/getAttestationContratPDFByData?' +
            qs.encode({
              csrfToken,
              aN:
                attestationData[0].listOfAttestationsContractByAccDTO[0].accDTO
                  .numAccCrypt + '==',
              bp: attestationData[0].bpDto.bpNumberCrypt + '==',
              cl:
                attestationData[0].listOfAttestationsContractByAccDTO[0]
                  .listOfAttestationContract[0].firstLastNameCrypt + '==',
              ct:
                attestationData[0].listOfAttestationsContractByAccDTO[0]
                  .listOfAttestationContract[0].attestationContractNumberCrypt +
                '==',
              ot: 'Tarif Bleu',
              _: Date.now()
            })
        }
      ],
      fields
    )
  }

  async testSession() {
    try {
      log('info', 'Testing session')
      await this.request(
        'https://particulier.edf.fr/bin/edf_rc/servlets/sasServlet?processus=TDB&forceAuth=true'
      )
      await this.request.post(
        'https://espace-client.edf.fr/sso/json/Internet/users?_action=idFromSession'
      )
      log('info', 'Session is OK')
      return true
    } catch (err) {
      log('warn', err.message)
      log('warn', 'Session failed')
      return false
    }
  }
}

const connector = new EdfConnector({
  debug: 'simple',
  cheerio: false,
  json: true,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:65.0) Gecko/20100101 Firefox/65.0',
    'Accept-Language': 'fr',
    // 'Accept-Encoding': 'gzip, deflate, br',
    Referer: 'https://espace-client.edf.fr/sso/XUI/',
    'Accept-API-Version': 'protocol=1.0,resource=2.0',
    'X-Password': 'anonymous',
    'X-Username': 'anonymous',
    'X-NoSession': 'true',
    'X-Requested-With': 'XMLHttpRequest'
  }
})

connector.run()

function getFormData($form) {
  return $form
    .serializeArray()
    .reduce((memo, input) => ({ ...memo, [input.name]: input.value }), {})
}
