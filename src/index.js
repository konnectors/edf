const {
  CookieKonnector,
  log,
  solveCaptcha,
  errors,
  utils,
  mkdirp
} = require('cozy-konnector-libs')
const qs = require('querystring')
const format = require('date-fns/format')
const TIME_LIMIT = Date.now() + 4 * 60 * 1000

class EdfConnector extends CookieKonnector {
  async fetch(fields) {
    this.initRequestHtml()
    if (!(await this.testSession())) {
      log('info', 'Found no correct session, logging in...')
      await this.authenticate(fields)
      log('info', 'Successfully logged in')
    }

    // get user data but we do nothing with it at the moment
    const { id } = await this.request.post(
      'https://espace-client.edf.fr/sso/json/Internet/users?_action=idFromSession'
    )
    await this.request(
      `https://espace-client.edf.fr/sso/json/internet/users/${id}`
    )

    await this.activateSession()

    const contracts = await this.request(
      'https://particulier.edf.fr/services/rest/authenticate/getListContracts'
    )
    this.contractFolders = {}
    this.contractDetails = {}
    for (const contractDetails of contracts.customerAccordContracts) {
      const contractNumber = Number(contractDetails.number)
      this.contractFolders[contractNumber] = `${contractNumber} ${
        contractDetails.adress.city
      }`
      this.contractDetails[contractNumber] = contractDetails
    }

    // need to do this call before getting files or else it does not work
    await this.request(
      'https://particulier.edf.fr/services/rest/edoc/getMyDocuments'
    )

    await this.getAttestationsForAllContracts(fields)

    await this.getEcheancierBills(fields)

    await this.getBillsForAllContracts(fields)
  }

  async getEcheancierBills(fields) {
    const result = await this.request(
      `https://particulier.edf.fr/services/rest/bill/consult?_=${Date.now()}`
    )

    if (!result || !result.feSouscriptionResponse) {
      log('warn', `getEcheancierBills: could not find contract`)
      return
    }

    const contractNumber = parseFloat(result.feSouscriptionResponse.tradeNumber)
    const destinationFolder =
      fields.folderPath + '/' + this.contractFolders[contractNumber]
    await mkdirp(destinationFolder)

    if (
      result.monthlyPaymentAllowedStatus === 'MENS' &&
      result.paymentSchedule &&
      result.paymentSchedule.deadlines
    ) {
      const startDate = new Date(result.paymentSchedule.startDate)
      const bills = result.paymentSchedule.deadlines
        .filter(bill => bill.payment === 'EFFECTUE')
        .map(bill => ({
          vendor: 'EDF',
          contractNumber,
          date: new Date(bill.encashmentDate),
          amount: bill.electricityAmount + bill.gazAmount,
          currency: '€',
          requestOptions: {
            json: false
          },
          fileAttributes: {
            metadata: {
              classification: 'invoicing',
              datetime: startDate,
              datetimeLabel: 'startDate',
              contentAuthor: 'edf',
              categories: ['energy'],
              subClassification: 'paiement_schedule',
              isSubscription: true,
              startDate
            }
          }
        }))

      const paymentDocuments = await this.request(
        'https://particulier.edf.fr/services/rest/edoc/getPaymentsDocuments'
      )

      if (
        paymentDocuments.length === 0 ||
        paymentDocuments[0].listOfPaymentsByAccDTO.length === 0 ||
        !paymentDocuments[0].listOfPaymentsByAccDTO[0].lastPaymentDocument ||
        !paymentDocuments[0].bpDto
      ) {
        log('warn', `could not find payment document`)
        return
      }

      const csrfToken = await this.getCsrfToken()
      const fileurl =
        'https://particulier.edf.fr/services/rest/document/getDocumentGetXByData?' +
        qs.encode({
          csrfToken,
          dn: 'CalendrierPaiement',
          pn:
            paymentDocuments[0].listOfPaymentsByAccDTO[0].lastPaymentDocument
              .parNumber,
          di:
            paymentDocuments[0].listOfPaymentsByAccDTO[0].lastPaymentDocument
              .documentNumber,
          bn: paymentDocuments[0].bpDto.bpNumberCrypt,
          an: paymentDocuments[0].listOfPaymentsByAccDTO[0].accDTO.numAccCrypt
        })
      const filename = `${format(
        new Date(
          paymentDocuments[0].listOfPaymentsByAccDTO[0].lastPaymentDocument.creationDate
        ),
        'YYYY'
      )}_EDF_echancier.pdf`

      await this.saveBills(
        bills.map(bill => ({ ...bill, filename, fileurl })),
        destinationFolder,
        {
          identifiers: ['edf'],
          sourceAccountIdentifier: fields.email
        }
      )
    }
  }

  async getAttestationsForAllContracts(fields) {
    const attestationData = await this.request(
      `https://particulier.edf.fr/services/rest/edoc/getAttestationsContract?_=${Date.now()}`
    )

    if (
      attestationData.length === 0 ||
      !attestationData[0].listOfAttestationsContractByAccDTO
    ) {
      log('warn', `Could not find an attestation`)
      return
    }

    for (const contract of attestationData[0]
      .listOfAttestationsContractByAccDTO) {
      if (
        !contract.listOfAttestationContract ||
        contract.listOfAttestationContract.length === 0
      ) {
        log('warn', `Could not find an attestation for a contract`)
        continue
      }
      const csrfToken = await this.getCsrfToken()

      const destinationFolder =
        fields.folderPath + '/' + this.contractFolders[contract.accDTO.numAcc]
      await mkdirp(destinationFolder)

      const startDate = new Date(
        this.contractDetails[
          contract.accDTO.numAcc
        ].contracts[0].lifeContract.startDate
      )

      await this.saveFiles(
        [
          {
            requestOptions: {
              json: false
            },
            shouldReplaceFile: () => true,
            filename: 'attestation de contrat.pdf',
            fileurl:
              'https://particulier.edf.fr/services/rest/document/getAttestationContratPDFByData?' +
              qs.encode({
                csrfToken,
                aN: contract.accDTO.numAccCrypt + '==',
                bp: contract.listOfAttestationContract[0].bpNumberCrypt + '==',
                cl: contract.listOfAttestationContract[0].firstLastNameCrypt,
                ct:
                  contract.listOfAttestationContract[0]
                    .attestationContractNumberCrypt + '==',
                ot: 'Tarif Bleu',
                _: Date.now()
              }),
            fileAttributes: {
              metadata: {
                pdl: this.contractDetails[contract.accDTO.numAcc].contracts[0]
                  .pdlnumber,
                classification: 'certificate',
                datetime: startDate,
                datetimeLabel: 'startDate',
                contentAuthor: 'edf',
                categories: ['energy'],
                subjects: ['subscription'],
                startDate,
                issueDate: new Date()
              }
            }
          }
        ],
        destinationFolder,
        {
          sourceAccountIdentifier: fields.email
        }
      )
    }
  }

  async getBillsForAllContracts(fields) {
    // give the same amount of time for each contract
    const billDocResp = await this.request(
      'https://particulier.edf.fr/services/rest/edoc/getBillsDocuments'
    )

    if (billDocResp.length === 0 || !billDocResp[0].bpDto) {
      log('warn', `getBillsForAllContracts: could not find bills`)
      return
    }

    const client = billDocResp[0].bpDto
    if (!client) {
      log('warn', `Could not find bills`)
      return
    }
    const accList = billDocResp[0].listOfBillsByAccDTO
    let remainingContractsNb = accList.length
    for (let acc of accList) {
      const contractTimeLimit = (TIME_LIMIT - Date.now()) / remainingContractsNb
      const destinationFolder =
        fields.folderPath + '/' + this.contractFolders[acc.accDTO.numAcc]
      log(
        'info',
        `${Math.round(contractTimeLimit / 1000)}s for ${destinationFolder}`
      )
      remainingContractsNb--
      await mkdirp(destinationFolder)
      const contract = acc.accDTO
      for (let bill of acc.listOfbills) {
        // set bill data
        const cozyBill = {
          vendor: 'EDF',
          vendorRef: bill.documentNumber,
          contractNumber: acc.accDTO.numAcc,
          amount: parseFloat(bill.billAmount),
          currency: '€',
          date: new Date(bill.creationDate),
          requestOptions: {
            json: false
          },
          fileAttributes: {
            metadata: {
              classification: 'invoicing',
              datetime: new Date(bill.creationDate),
              datetimeLabel: 'issueDate',
              contentAuthor: 'edf',
              categories: ['energy'],
              subClassification: 'invoice',
              isSubscription: true,
              issueDate: new Date(bill.creationDate)
            }
          }
        }

        if (cozyBill.amount < 0) {
          cozyBill.amount = Math.abs(cozyBill.amount)
          cozyBill.isRefund = true
        }

        cozyBill.filename = `${utils.formatDate(
          cozyBill.date
        )}_EDF_${cozyBill.amount.toFixed(2)}€.pdf`
        const csrfToken = await this.getCsrfToken()
        cozyBill.fileurl =
          'https://particulier.edf.fr/services/rest/document/getDocumentGetXByData?' +
          qs.encode({
            csrfToken,
            dn: 'FACTURE',
            pn: bill.parNumber,
            di: bill.documentNumber,
            bn: client.bpNumberCrypt,
            an: contract.numAccCrypt
          })
        await this.saveBills([cozyBill], destinationFolder, {
          identifiers: ['edf'],
          timeout: contractTimeLimit + Date.now(),
          sourceAccountIdentifier: fields.email
        })
      }
    }
  }
  async authenticate(fields) {
    log('info', 'fields')
    log('info', JSON.stringify(Object.keys(fields)))
    if (!fields.email) {
      log(
        'error',
        'The account is not correctly configured the email field is missing'
      )
      throw new Error(errors.LOGIN_FAILED)
    }
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

    await this.request.post(
      'https://espace-client.edf.fr/sso/json/authenticate?realm=Internet&authIndexType=service&authIndexValue=ldapservice&authIndexType=service&authIndexValue=ldapservice'
    )

    const websiteKey = auth['callbacks'][4]['output'][0]['value']
    const websiteURL =
      'https://espace-client.edf.fr/sso/XUI/#login/Internet&authIndexType=service&authIndexValue=ldapservice'
    const captchaToken = await solveCaptcha({ websiteURL, websiteKey })

    auth['callbacks'][0]['input'][0]['value'] = fields.email
    auth['callbacks'][1]['input'][0]['value'] = fields.password
    auth['callbacks'][2]['input'][0]['value'] = captchaToken
    auth['callbacks'][3]['input'][0]['value'] = '0'

    try {
      const { tokenId } = await this.request.post(
        'https://espace-client.edf.fr/sso/json/Internet/authenticate?authIndexType=service&authIndexValue=ldapservice',
        {
          body: auth,
          gzip: true,
          headers: {
            Accept: 'application/json, text/javascript, */*; q=0.01',
            Connection: 'keep-alive',
            Pragma: 'no-cache',
            TE: 'Trailers'
          }
        }
      )
      this._jar._jar.setCookieSync(
        `ivoiream=${tokenId}`,
        'https://espace-client.edf.fr',
        {}
      )
    } catch (err) {
      log('error', err.message)
      throw new Error(errors.LOGIN_FAILED)
    }

    let sessionWorks = null
    try {
      sessionWorks = await this.testSession()
    } catch (err) {
      log('error', err.message)
      sessionWorks = false
    }
    if (!sessionWorks) {
      throw new Error(errors.VENDOR_DOWN)
    }
  }

  async activateSession() {
    const valid$ = await this.requestHtml(
      'https://particulier.edf.fr/fr/accueil/espace-client/tableau-de-bord.html'
    )

    // sometimes edf return a form which we have to submit...
    if (valid$('body').attr('onload')) {
      const $form = valid$('form')
      await this.requestHtml.post($form.attr('action'), {
        form: getFormData($form)
      })
    }

    await this.requestHtml(
      'https://particulier.edf.fr/services/rest/openid/checkAuthenticate'
    )
  }

  async testSession() {
    try {
      log('info', 'Testing session')
      await this.activateSession()

      await this.requestHtml.post(
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

  async getCsrfToken() {
    const dataCsrfToken = await this.request(
      `https://particulier.edf.fr/services/rest/init/initPage?_=${Date.now()}`
    )
    return dataCsrfToken.data
  }

  initRequestHtml() {
    this.requestHtml = this.requestFactory({
      cheerio: true,
      json: false,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:65.0) Gecko/20100101 Firefox/65.0',
        'Accept-Language': 'fr',
        Referer: 'https://espace-client.edf.fr/sso/XUI/',
        'Accept-API-Version': 'protocol=1.0,resource=2.0'
      }
    })
  }
}

// most of the request are done to the API
const connector = new EdfConnector({
  // debug: 'json',
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
