import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { blobToBase64 } from 'cozy-clisk/dist/contentscript/utils'
import ky from 'ky'
import Minilog from '@cozy/minilog'
import { format } from 'date-fns'
import waitFor from 'p-wait-for'
import pRetry from 'p-retry'
import pTimeout from 'p-timeout'
import { formatHousing } from './utils'
import { wrapTimerFactory } from 'cozy-clisk/dist/libs/wrapTimer'
import { Q } from 'cozy-client/dist/queries/dsl'
import RequestInterceptor from './interceptor'

// TODO use a flag to change this value
let FORCE_FETCH_ALL = false

const log = Minilog('ContentScript')
Minilog.enable()

const BASE_URL = 'https://particulier.edf.fr'
const DEFAULT_PAGE_URL =
  BASE_URL + '/fr/accueil/espace-client/tableau-de-bord.html'

const interceptor = new RequestInterceptor([
  {
    label: 'initPage',
    method: 'GET',
    url: 'rest/init/initPage',
    serialization: 'json'
  },
  {
    label: 'getBillsDocuments',
    method: 'GET',
    url: 'rest/edoc/getBillsDocuments',
    serialization: 'json'
  },
  {
    label: 'billConsult',
    method: 'GET',
    url: 'rest/bill/consult',
    serialization: 'json'
  }
])
interceptor.init()

class EdfContentScript extends ContentScript {
  constructor() {
    super()
    const logInfo = message => this.log('info', message)
    const wrapTimerInfo = wrapTimerFactory({ logFn: logInfo })

    this.fetchContact = wrapTimerInfo(this, 'fetchContact')
    this.fetchContracts = wrapTimerInfo(this, 'fetchContracts')
    this.fetchBillsForAllContracts = wrapTimerInfo(
      this,
      'fetchBillsForAllContracts'
    )
    this.fetchAttestations = wrapTimerInfo(this, 'fetchAttestations')
    this.fetchEcheancierBills = wrapTimerInfo(this, 'fetchEcheancierBills')
    this.fetchHousing = wrapTimerInfo(this, 'fetchHousing')
  }

  async downloadFileInWorker(entry) {
    this.log('debug', 'downloading file in worker with fetch')
    if (entry.fileurl) {
      const response = await fetch(entry.fileurl)
      entry.blob = await response.blob()
      entry.dataUri = await blobToBase64(entry.blob)
    }
    return entry.dataUri
  }

  async init(options) {
    await super.init(options)
    interceptor.on('response', response => {
      this.bridge.emit('workerEvent', {
        event: 'interceptedResponse',
        payload: response
      })
    })
  }

  waitForInterception(label, options = {}) {
    const timeout = options?.timeout ?? 60000
    const interceptionPromise = new Promise(resolve => {
      const listener = ({ event, payload }) => {
        if (event === 'interceptedResponse' && payload.label === label) {
          this.bridge.removeEventListener('workerEvent', listener)
          resolve(payload)
        }
      }
      this.bridge.addEventListener('workerEvent', listener)
    })

    return pTimeout(interceptionPromise, {
      milliseconds: timeout,
      message: `Timed out after waiting ${timeout}ms for interception of ${label}`
    })
  }

  // ///////
  // PILOT//
  // ///////
  async goToLoginForm() {
    await pRetry(
      async () => {
        await this.goto(DEFAULT_PAGE_URL)
        await this.PromiseRaceWithError(
          [
            this.runInWorkerUntilTrue({ method: 'waitForVendorErrorMessage' }),
            this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' }),
            this.runInWorkerUntilTrue({ method: 'waitForLoginForm' })
          ],
          'goToLoginForm: waiting for any authentication confirmation or login form...'
        )
        if (await this.runInWorker('findVendorErrorMessage')) {
          throw new Error('VENDOR_DOWN')
        }
      },
      {
        retries: 1,
        onFailedAttempt: async error => {
          if (error.message === 'VENDOR_DOWN') {
            this.log(
              'warn',
              'goToLoginForm: Got VENDOR_DOWN message, trying again'
            )
          } else {
            throw error
          }
        }
      }
    )
    await this.goto(DEFAULT_PAGE_URL)
    await this.PromiseRaceWithError(
      [
        this.waitForElementInWorker('h1', {
          includesText: `Une erreur s'est produite`
        }),
        this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' }),
        this.runInWorkerUntilTrue({ method: 'waitForLoginForm' })
      ],
      'goToLoginForm: waiting for any authentication confirmation or login form...'
    )
  }
  async ensureNotAuthenticated() {
    this.log('info', '🤖 starting ensureNotAuthenticated')
    await this.goToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (authenticated === false) {
      this.log('info', 'Already not authenticated')
      return true
    }
    this.log('info', 'authenticated, triggering the deconnection')
    await this.runInWorker('logout')
    await this.waitForElementInWorker(`[data-label='Je me reconnecte']`)
    return true
  }

  async logout() {
    if (window.deconnexion) {
      window.deconnexion()
    } else {
      throw new Error(
        'Could not logout from the current page. No window.deconnexion function found'
      )
    }
  }

  async ensureAuthenticated({ account }) {
    this.log('info', '🤖 starting ensureAuthenticated')
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    await this.goToLoginForm()
    if (await this.runInWorker('checkAuthenticated')) {
      this.log('info', 'Authenticated')
      return true
    }
    this.log('debug', 'Not authenticated')

    let credentials = await this.getCredentials()
    if (credentials && credentials.email && credentials.password) {
      try {
        this.log('debug', 'Got credentials, trying autologin')
        await this.autoLogin(credentials)
      } catch (err) {
        log.warn('autoLogin error' + err.message)
        await this.waitForUserAuthentication()
      }
    } else {
      this.log('debug', 'No credentials saved, waiting for user input')
      await this.waitForUserAuthentication()
    }
    return true
  }

  async autoLogin(credentials) {
    this.log('info', '🤖 autologin start')
    this.log('debug', 'fill email field')
    const emailInputSelector = '#email'
    const passwordInputSelector = '#password2-password-field'
    const emailNextButtonSelector = '#username-next-button > span'
    const passwordNextButtonSelector = '#password2-next-button > span'
    const otpNeededSelector = '.auth #title-hotp3'
    await this.waitForElementInWorker(emailInputSelector)
    await this.runInWorker('fillText', emailInputSelector, credentials.email)
    await this.runInWorker('click', emailNextButtonSelector)

    this.log('debug', 'wait for password field or otp')
    await this.PromiseRaceWithError(
      [
        this.waitForElementInWorker(passwordInputSelector),
        this.waitForElementInWorker(otpNeededSelector)
      ],
      'autoLogin: wait for password field or otp'
    )

    if (await this.runInWorker('checkOtpNeeded')) {
      log.warn('Found otp needed')
      throw new Error('OTP_NEEDED')
    }
    this.log('debug', 'No otp needed')

    this.log('debug', 'fill password field')
    await this.runInWorker(
      'fillText',
      passwordInputSelector,
      credentials.password
    )
    await this.runInWorker('click', passwordNextButtonSelector)

    await this.PromiseRaceWithError(
      [
        this.waitForElementInWorker('.field-container--error'), // do not wait for .msg__error because allways present but invisible
        this.waitForAuthenticatedWithRetry()
      ],
      'waiting end of autologin'
    )

    if (await this.isElementInWorker('.field-container--error')) {
      throw new Error('Wrong credentials')
    }
  }

  async waitForUserAuthentication() {
    this.log('info', '🤖 waitForUserAuthentication start')
    await this.setWorkerState({ visible: true, url: DEFAULT_PAGE_URL })
    await this.waitForAuthenticatedWithRetry()
    await this.setWorkerState({ visible: false })
  }

  async waitForAuthenticatedWithRetry() {
    await pRetry(
      async () =>
        await this.PromiseRaceWithError(
          [
            this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' }),
            this.runInWorkerUntilTrue({ method: 'waitForVendorErrorMessage' })
          ],
          'waitForAuthenticatedWithRetry'
        ),
      {
        retries: 1,
        onFailedAttempt: async error => {
          if (error.message === 'VENDOR_DOWN') {
            this.log(
              'warn',
              'waitForAuthenticatedWithRetry: Got VENDOR_DOWN message, trying again'
            )
            // sometimes the vendor down message on edf is fixable with a reload of the login form
            await this.goToLoginForm()
          } else {
            throw error
          }
        }
      }
    )
  }

  async fetch(context) {
    this.log('info', '🤖 fetch start')
    const { sourceAccountIdentifier, manifest, trigger } = context

    // force fetch all data (the long way) when last trigger execution is older than 30 days
    // or when the last job was an error
    const isLastJobError =
      trigger.current_state?.last_failure > trigger.current_state?.last_success
    const distanceInDays = getDateDistanceInDays(
      trigger.current_state?.last_execution
    )
    if (distanceInDays >= 30 || isLastJobError) {
      this.log('debug', `isLastJobError: ${isLastJobError}`)
      this.log('debug', `distanceInDays: ${distanceInDays}`)
      FORCE_FETCH_ALL = true
    }

    if (this.store && this.store.email && this.store.password) {
      this.log('info', 'saving credentials')
      await this.saveCredentials(this.store)
    }
    const contact = await this.withRetry({
      label: 'fetchContact',
      run: () => this.fetchContact(),
      selectorToWait: "a.accessPage[href*='mes-documents.html']"
    })
    const contracts = await this.withRetry({
      label: 'fetchContracts',
      run: () => this.fetchContracts(),
      selectorToWait: "a.accessPage[href*='mes-documents.html']"
    })
    await this.withRetry({
      label: 'fetchAttestations',
      run: () => this.fetchAttestations(contracts, context),
      selectorToWait: '.contract-icon'
    })
    await this.withRetry({
      label: 'fetchBillsForAllContracts',
      run: () => this.fetchBillsForAllContracts(contracts, context),
      selectorToWait: '#facture, #factureSelection'
    })
    const echeancierResult = await this.withRetry({
      label: 'fetchEcheancierBills',
      run: () => this.fetchEcheancierBills(contracts, context),
      selectorToWait: `.timeline-header__download, a.accessPage[href*='factures-et-paiements.html']`
    })

    // fetch the housing data only if we do not have an existing identity or if the existing
    // identity is older than 1 month
    let lastIdentityUpdatedSinceDays = Infinity
    if (!FORCE_FETCH_ALL) {
      const existingIdentities = await this.queryAll(
        Q('io.cozy.identities')
          .where({
            identifier: sourceAccountIdentifier,
            'cozyMetadata.createdByApp': manifest.slug
          })
          .indexFields(['identifier', 'cozyMetadata.createdByApp'])
      )
      const existingIdentity = existingIdentities?.[0]
      lastIdentityUpdatedSinceDays = existingIdentity
        ? getDateDistanceInDays(existingIdentity.cozyMetadata.updatedAt)
        : Infinity
    }

    if (FORCE_FETCH_ALL || lastIdentityUpdatedSinceDays >= 30) {
      this.log(
        'info',
        `Existing identity updated since more than 30 days or no identity. Updating it`
      )
      const identity = { contact }
      const housingRawData = await this.fetchHousing()
      if (housingRawData !== null) {
        const housing = formatHousing(
          contracts,
          echeancierResult,
          housingRawData,
          this.log.bind(this)
        )
        identity.housing = housing
      }
      await this.saveIdentity(identity)
    } else {
      this.log(
        'info',
        `Existing identity last updated ${lastIdentityUpdatedSinceDays} days ago. No need to update it`
      )
    }
  }

  async fetchHousing() {
    this.log('info', '🤖 fetchHousing starts')
    const notConnectedSelector = 'div.session-expired-message button'
    try {
      await this.navigateToConsoPage(notConnectedSelector)
    } catch (err) {
      if (err.message === 'NO_EQUILIBRE_ACCOUNT') {
        return null
      } else {
        throw err
      }
    }

    // first step : if not connected, click on the connect button
    const isConnected = await this.runInWorker('checkConnected')
    if (!isConnected) {
      await this.runInWorker('click', notConnectedSelector)
    }
    await this.PromiseRaceWithError(
      [
        this.waitForElementInWorker('button.multi-site-button', {
          timeout: 60000
        }),
        this.waitForElementInWorker('a[class="header-dashboard-button"]', {
          timeout: 60000
        })
      ],
      'fetchHousing: wait for housing page'
    )
    // second step, if multiple contracts, select the first one
    const multipleContracts = await this.runInWorker('checkMultipleContracts')
    if (multipleContracts) {
      const multiContractsIds = await this.runInWorker('getMultiContractsIds')
      await this.runInWorker('selectContract', multiContractsIds[0])
      const multipleHousing = await this.computeHousing(multiContractsIds)
      this.log('info', 'fetchMutlipleHousing done')
      return multipleHousing
    } else {
      const singleHousing = await this.computeHousing()
      this.log('info', 'fetchSingleHousing done')
      return singleHousing
    }
  }

  async navigateToConsoPage(notConnectedSelector) {
    this.log('info', '🤖 navigateToConsoPage starts')
    const consoLinkSelector =
      'a[href="/fr/accueil/economies-energie/comprendre-reduire-consommation-electrique-gaz.html"]'
    const continueLinkSelector = "a[href='https://equilibre.edf.fr/comprendre']"
    await this.clickAndWait(consoLinkSelector, continueLinkSelector)
    await this.runInWorker('click', continueLinkSelector)
    await this.PromiseRaceWithError(
      [
        this.waitForElementInWorker('.zero-site-message-large', {
          includesText: 'Nous n’avons pas trouvé votre compte'
        }),
        this.waitForElementInWorker(notConnectedSelector),
        this.waitForElementInWorker('.header-logo'),
        this.waitForElementInWorker('button.multi-site-button')
      ],
      'navigateToConsoPage: wait for conso page'
    )
    if (
      await this.isElementInWorker('.zero-site-message-large', {
        includesText: 'Nous n’avons pas trouvé votre compte'
      })
    ) {
      this.log(
        'warn',
        'The user does not have any equilibre account. Cannot fetch consumption data'
      )
      throw new Error('NO_EQUILIBRE_ACCOUNT')
    }
  }

  async computeHousing(multiContractsIds) {
    this.log('info', '🤖 computeHousing starts')
    // Here if there is a single contract, we don't need the precise id of it
    // So no need to retrieve it, but the function is waiting for an array, so we give it with a single entry
    // To avoid unecessary steps in computeHousing
    const contractsIds = multiContractsIds ? multiContractsIds : ['1']
    let computedHousings = []
    for (let i = 0; i < contractsIds.length; i++) {
      await this.runInWorker('waitForSessionStorage')
      const {
        constructionDate = {},
        equipment = {},
        heatingSystem = {},
        housingType = {},
        lifeStyle = {},
        surfaceInSqMeter = {},
        residenceType = {}
      } = await this.runInWorker('getHomeProfile')

      const contractElec = await this.runInWorker('getContractElec')

      const rawConsumptions = await this.runInWorker('getConsumptions')

      const pdlNumber = await this.runInWorker('getContractPdlNumber')

      const houseConsumption = {
        pdlNumber,
        constructionDate,
        equipment,
        heatingSystem,
        housingType,
        lifeStyle,
        surfaceInSqMeter,
        residenceType,
        contractElec,
        rawConsumptions
      }
      computedHousings.push(houseConsumption)

      if (i === contractsIds.length - 1) {
        this.log('info', 'no more contracts after this one')
        break
      }
      await this.runInWorker('changeContract', contractsIds[i + 1])
      await this.waitForElementInWorker('button')
      await this.clickAndWait('button', 'button.multi-site-button')
      await this.clickAndWait(
        `button[id="${contractsIds[i + 1]}"]`,
        'a[class="header-dashboard-button"]'
      )
    }
    return computedHousings
  }

  async changeContract(id) {
    this.log('info', 'changeContract starts')
    window.localStorage.setItem('site-ext-id', `${id}`)
    window.location.reload()
  }

  selectContract(id) {
    this.log('info', 'selectContract starts')
    document.querySelector(`button[id="${id}"]`).click()
  }

  async fetchEcheancierBills(contracts, context) {
    this.log('info', 'fetching echeancier bills')

    // files won't download if this page is not fully loaded before
    const billLinkSelector = "a.accessPage[href*='factures-et-paiements.html']"

    await this.runInWorker('click', billLinkSelector)
    const { response: result } = await this.waitForInterception('billConsult')

    if (!result || !result.feSouscriptionResponse) {
      log.warn('fetchEcheancierBills: could not find contract')
      return
    }

    const contractNumber = parseFloat(
      result?.feSouscriptionResponse?.tradeNumber
    )
    const subPath = contracts?.folders?.[contractNumber]
    if (!subPath) {
      log.warn(
        `fetchEcheancierBills: could not create subPath for ${contractNumber}`
      )
      return
    }

    const isMonthly =
      result.monthlyPaymentAllowedStatus === 'MENS' &&
      result.paymentSchedule &&
      result?.paymentSchedule?.deadlines

    if (isMonthly) {
      const startDate = new Date(result?.paymentSchedule?.startDate)
      const bills = result.paymentSchedule.deadlines
        .filter(bill => bill.payment === 'EFFECTUE')
        .map(bill => ({
          vendor: 'EDF',
          contractNumber,
          startDate,
          date: new Date(bill.encashmentDate),
          amount: bill.electricityAmount + bill.gazAmount,
          currency: '€'
        }))

      const paymentDocuments = await this.runInWorker(
        'getKyJson',
        BASE_URL + '/services/rest/edoc/getPaymentsDocuments'
      )

      if (
        paymentDocuments.length === 0 ||
        paymentDocuments[0].listOfPaymentsByAccDTO.length === 0 ||
        !paymentDocuments[0].listOfPaymentsByAccDTO[0].lastPaymentDocument ||
        !paymentDocuments[0].bpDto
      ) {
        log.warn('could not find payment document')
        return
      }

      const csrfToken = await this.getCsrfToken()
      const fileurl =
        BASE_URL +
        '/services/rest/document/getDocumentGetXByData?' +
        new URLSearchParams({
          csrfToken,
          dn: 'CalendrierPaiement',
          pn: paymentDocuments[0].listOfPaymentsByAccDTO[0].lastPaymentDocument
            .parNumber,
          di: paymentDocuments[0].listOfPaymentsByAccDTO[0].lastPaymentDocument
            .documentNumber,
          bn: paymentDocuments[0].bpDto.bpNumberCrypt,
          an: paymentDocuments[0].listOfPaymentsByAccDTO[0].accDTO.numAccCrypt
        })
      const filename = `${format(
        new Date(
          paymentDocuments[0]?.listOfPaymentsByAccDTO?.[0]?.lastPaymentDocument?.creationDate
        ),
        'yyyy'
      )}_EDF_echancier.pdf`

      if (bills.length > 0) {
        await this.saveBills(
          bills.map(bill => ({
            ...bill,
            filename,
            fileurl,
            recurrence: 'monthly',
            fileAttributes: {
              metadata: {
                invoiceNumber: bill.vendorRef,
                contentAuthor: 'edf',
                datetime: bill.date,
                datetimeLabel: 'startDate',
                isSubscription: true,
                startDate: bill.date,
                carbonCopy: true
              }
            }
          })),
          {
            context,
            subPath,
            fileIdAttributes: ['vendorRef', 'startDate'],
            contentType: 'application/pdf',
            qualificationLabel: 'energy_invoice'
          }
        )
      }
    }

    return { isMonthly }
  }

  async fetchBillsForAllContracts(contracts, context) {
    this.log('info', 'fetchBillsForAllContracts')
    // files won't download if this page is not fully loaded before
    const billButtonSelector = '#facture'
    if (await this.isElementInWorker(billButtonSelector)) {
      await this.runInWorker('click', billButtonSelector)
    }

    const { response: billDocResp } = await this.waitForInterception(
      'getBillsDocuments'
    )

    if (billDocResp.length === 0) {
      log.warn('fetchBillsForAllContracts: could not find bills')
      return
    }

    for (const bp of billDocResp) {
      if (!bp.bpDto) {
        log.warn('fetchBillsForAllContracts: could not find bills')
        continue
      }

      const client = bp.bpDto
      if (!client) {
        log.warn('fetchBillsForAllContracts: Could not find bills')
        return
      }
      const accList = bp.listOfBillsByAccDTO
      for (let acc of accList) {
        const contract = acc.accDTO
        const subPath = contracts?.folders?.[contract.numAcc]
        const cozyBills = []
        for (let bill of acc.listOfbills) {
          const cozyBill = {
            vendor: 'EDF',
            vendorRef: bill.documentNumber,
            contractNumber: contract.numAcc,
            amount: parseFloat(bill.billAmount),
            currency: '€',
            date: new Date(bill.creationDate)
          }

          if (cozyBill.amount < 0) {
            cozyBill.amount = Math.abs(cozyBill.amount)
            cozyBill.isRefund = true
          }

          cozyBill.filename = `${format(
            cozyBill.date,
            'yyyy-MM-dd'
          )}_EDF_${cozyBill.amount.toFixed(2)}€.pdf`
          const csrfToken = await this.getCsrfToken()
          cozyBill.fileurl =
            BASE_URL +
            '/services/rest/document/getDocumentGetXByData?' +
            new URLSearchParams({
              csrfToken,
              dn: 'FACTURE',
              pn: bill.parNumber,
              di: bill.documentNumber,
              bn: client.bpNumberCrypt,
              an: contract.numAccCrypt
            })

          cozyBill.fileAttributes = {
            metadata: {
              invoiceNumber: bill.vendorRef,
              contentAuthor: 'edf',
              datetime: new Date(bill.creationDate),
              datetimeLabel: 'issueDate',
              isSubscription: true,
              issueDate: new Date(bill.creationDate),
              carbonCopy: true
            }
          }
          cozyBills.push(cozyBill)
        }
        if (cozyBills.length > 0) {
          await this.saveBills(cozyBills, {
            context,
            subPath,
            fileIdAttributes: ['vendorRef'],
            contentType: 'application/pdf',
            qualificationLabel: 'energy_invoice'
          })
        }
      }
    }
  }

  async getCsrfToken() {
    if (this.csrfToken) {
      return this.csrfToken
    }
    throw new Error('No csrf token intercepted on page')
  }

  async fetchAttestations(contracts, context) {
    this.log('info', 'fetching attestations')
    await this.goto(DEFAULT_PAGE_URL)

    const myDocumentsLinkSelector = "a.accessPage[href*='mes-documents.html']"
    const contractDisplayedSelector = '.contract-icon'
    await this.waitForElementInWorker(myDocumentsLinkSelector)
    await this.clickAndWait(myDocumentsLinkSelector, contractDisplayedSelector)

    const attestationData = await this.runInWorker(
      'getKyJson',
      BASE_URL + `/services/rest/edoc/getAttestationsContract?_=${Date.now()}`
    )

    if (attestationData.length === 0) {
      this.log('debug', 'Could not find any attestation')
      return
    }

    for (const bp of attestationData) {
      if (!bp.listOfAttestationsContractByAccDTO) {
        this.log('debug', 'Could not find an attestation')
        continue
      }

      for (const contract of bp.listOfAttestationsContractByAccDTO) {
        if (
          !contract.listOfAttestationContract ||
          contract.listOfAttestationContract.length === 0
        ) {
          this.log('debug', 'Could not find an attestation for')
          this.log('debug', JSON.stringify(bp, null, 2))
          continue
        }
        const csrfToken = await this.getCsrfToken()

        const subPath = contracts?.folders?.[contract.accDTO.numAcc]

        await this.saveFiles(
          [
            {
              forceReplaceFile: true,
              filename: 'attestation de contrat edf.pdf',
              vendorRef:
                contracts.details[contract.accDTO.numAcc].contracts[0]
                  .pdlnumber,
              fileurl:
                BASE_URL +
                '/services/rest/document/getAttestationContratPDFByData?' +
                new URLSearchParams({
                  csrfToken,
                  aN: contract.accDTO.numAccCrypt + '==',
                  bp:
                    contract.listOfAttestationContract[0].bpNumberCrypt + '==',
                  cl: contract.listOfAttestationContract[0].firstLastNameCrypt,
                  ct:
                    contract.listOfAttestationContract[0]
                      .attestationContractNumberCrypt + '==',
                  ot: contract.listOfAttestationContract[0].offerName,
                  _: Date.now()
                }),
              fileAttributes: {
                metadata: {
                  contentAuthor: 'edf',
                  carbonCopy: true
                }
              }
            }
          ],
          {
            context,
            subPath,
            fileIdAttributes: ['vendorRef'],
            contentType: 'application/pdf'
          }
        )
      }
    }
  }

  async fetchContracts() {
    this.log('info', 'fetching contracts')

    const contracts = await this.runInWorker(
      'getKyJson',
      BASE_URL + '/services/rest/authenticate/getListContracts'
    )
    const result = { folders: {}, details: {} }

    for (const contractDetails of contracts.customerAccordContracts) {
      const contractNumber = Number(contractDetails.number)
      result.folders[
        contractNumber
      ] = `${contractNumber} ${contractDetails.adress.city}`
      result.details[contractNumber] = contractDetails
    }
    return result
  }

  async fetchContact() {
    this.log('info', 'fetching contact')

    const json = await this.runInWorker(
      'getKyJson',
      BASE_URL + '/services/rest/context/getCustomerContext'
    )

    let ident = {}
    if (!json.bp) {
      throw new Error('Not enough data to make identiy, only request failed')
    }
    if (json.bp.lastName && json.bp.firstName) {
      ident.name = {
        givenName: json.bp.firstName,
        familyName: json.bp.lastName
      }
    }
    if (
      json.bp.streetNumber &&
      json.bp.streetName &&
      json.bp.postCode &&
      json.bp.city
    ) {
      ident.address = [
        {
          street: `${json.bp.streetNumber} ${json.bp.streetName}`,
          postcode: json.bp.postCode,
          city: json.bp.city,
          formattedAddress:
            `${json.bp.streetNumber} ${json.bp.streetName}` +
            ` ${json.bp.postCode} ${json.bp.city}`
        }
      ]
    }
    if (json.bp.mail) {
      ident.email = [{ address: json.bp.mail }]
    }
    if (json.bp.mobilePhoneNumber) {
      if (ident.phone) {
        ident.phone.push({ number: json.bp.mobilePhoneNumber, type: 'mobile' })
      } else {
        ident.phone = [{ number: json.bp.mobilePhoneNumber, type: 'mobile' }]
      }
    }
    if (json.bp.fixePhoneNumber) {
      if (ident.phone) {
        ident.phone.push({ number: json.bp.fixePhoneNumber, type: 'home' })
      } else {
        ident.phone = [{ number: json.bp.fixePhoneNumber, type: 'home' }]
      }
    }

    return ident
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite start')

    const credentials = await this.getCredentials()
    const credentialsEmail = credentials?.email
    const storeEmail = this.store?.email
    let email = credentialsEmail || storeEmail
    if (!credentialsEmail && !storeEmail) {
      this.log(
        'info',
        'No credentials email, trying to find email from edf api'
      )
      const context = await this.runInWorker(
        'getKyJson',
        BASE_URL + '/services/rest/context/getCustomerContext'
      )
      email = context?.bp?.mail
    }

    if (email) {
      return {
        sourceAccountIdentifier: email
      }
    } else {
      throw new Error(
        'No user data identifier found. The connector should be fixed'
      )
    }
  }

  async onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      const { email, password } = payload || {}
      if (email) {
        // store the email and password in the pilot to send it
        // in the beginning of the fetch method when the launcher
        // is ready to receive it
        this.store = { email, password }
      }
    } else if (
      event === 'interceptedResponse' &&
      payload.label === 'initPage'
    ) {
      // store edf token token, intercepted in xhr response to use it when calling edf api
      this.log('debug', 'intercepted new edf token')
      this.csrfToken = payload?.response?.data
      if (!this.csrfToken) {
        this.log(
          'error',
          'Wrong edf token intercepted: ',
          JSON.stringify(payload, null, 2)
        )
      }
    }
  }

  // ////////
  // WORKER//
  // ////////
  async onWorkerReady() {
    await this.waitForDomReady()
    document.body.addEventListener('click', e => {
      const clickedElementId = e.target.getAttribute('id')
      const clickedElementParentId = e.target?.parentElement?.getAttribute('id')
      if (
        [clickedElementId, clickedElementParentId].includes(
          'username-next-button'
        )
      ) {
        const email = document.querySelector('#email')?.value
        // will use this email in getUserDataFromWebsite
        this.bridge.emit('workerEvent', {
          event: 'loginSubmit',
          payload: { email }
        })
      } else if (
        [clickedElementId, clickedElementParentId].includes(
          'password2-next-button'
        )
      ) {
        const email = document.querySelector('#emailHid')?.value
        const password = document.querySelector(
          '#password2-password-field'
        )?.value
        this.bridge.emit('workerEvent', {
          event: 'loginSubmit',
          payload: { email, password }
        })
      }
    })
  }
  async checkAuthenticated() {
    const $contracts = document.querySelectorAll('.selected-contrat')
    const isAuthentifiedWithMultipleContracts = Boolean($contracts.length)
    const vendorErrorMsg = document.querySelector(
      '.auth__title--error'
    )?.innerText

    if (vendorErrorMsg) {
      this.log('warn', vendorErrorMsg)
      throw new Error('VENDOR_DOWN')
    }

    const isAuthentifiedWithOneContract = Boolean(
      document.querySelector('.isAuthentified.show')
    )
    return isAuthentifiedWithOneContract || isAuthentifiedWithMultipleContracts
  }
  async checkLoginForm() {
    return Boolean(document.querySelector('.auth #email'))
  }
  async checkOtpNeeded() {
    return Boolean(document.querySelector('.auth #title-hotp3'))
  }

  async waitForLoginForm() {
    await waitFor(this.checkLoginForm, {
      interval: 1000,
      timeout: 30 * 1000
    })
    return true
  }

  findVendorErrorMessage() {
    return document.querySelector('.auth__title--error')?.innerText
  }

  async waitForVendorErrorMessage() {
    let vendorErrorMsg
    await waitFor(
      () => {
        vendorErrorMsg = this.findVendorErrorMessage()
        return vendorErrorMsg ? true : false
      },
      {
        interval: 1000,
        timeout: 60 * 1000
      }
    )
    if (vendorErrorMsg) {
      this.log('warn', `Got vendor error message: ${vendorErrorMsg}`)
      throw new Error('VENDOR_DOWN')
    }
  }

  checkConnected() {
    const notConnectedSelector = 'div.session-expired-message button'
    return !document.querySelector(notConnectedSelector)
  }

  checkMultipleContracts() {
    return document.querySelector('button.multi-site-button')
  }

  async waitForHomeProfile() {
    return await waitFor(
      () => Boolean(window.sessionStorage.getItem('datacache:profil')),
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
  }

  async waitForSessionStorage() {
    await waitFor(
      () => {
        const result = Boolean(
          window.sessionStorage.getItem('datacache:profil')
        )
        return result
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
  }

  getHomeProfile() {
    this.log('info', 'getHomeProfile starts')
    const homeStorage = window.sessionStorage.getItem('datacache:profil')
    if (homeStorage) {
      return JSON.parse(homeStorage).value.data.housing
    }
    return {}
  }

  getContractElec() {
    const contractStorage = window.sessionStorage.getItem(
      'datacache:contract-elec'
    )
    if (contractStorage) {
      return JSON.parse(contractStorage).value.data
    }
    return {}
  }

  getConsumptions() {
    const result = {}
    const elecConsumptionKey = Object.keys(window.sessionStorage).find(k =>
      k.includes('datacache:monthly-elec-consumptions')
    )
    if (elecConsumptionKey) {
      result.elec = JSON.parse(
        window.sessionStorage.getItem(elecConsumptionKey)
      ).value.data
    }

    const gasConsumptionKey = Object.keys(window.sessionStorage).find(k =>
      k.includes('datacache:monthly-gas-consumptions')
    )
    if (gasConsumptionKey) {
      result.gas = JSON.parse(
        window.sessionStorage.getItem(gasConsumptionKey)
      ).value.data
    }
    return result
  }

  getMultiContractsIds() {
    let contractsIds = []
    const foundContracts = document.querySelectorAll('button.multi-site-button')
    for (const contract of foundContracts) {
      contractsIds.push(contract.getAttribute('id'))
    }
    return contractsIds
  }

  getContractPdlNumber() {
    const pdlNumber = JSON.parse(
      window.localStorage.getItem('site-ext-id')
    ).value
    return pdlNumber
  }

  getKyJson(url) {
    return ky
      .get(url, {
        retry: {
          limit: 5,
          statusCodes: [404]
        },
        hooks: {
          beforeRetry: [
            ({ error, retryCount }) => {
              this.log(
                'warn',
                `Retrying get ${url}, attempt ${retryCount} after error ${error?.message}`
              )
            }
          ],
          beforeError: [
            error => {
              const { response } = error
              this.log(
                'warn',
                `request ${url} failed with status ${response.status} and message : ${response.message}`
              )

              return error
            }
          ]
        }
      })
      .json()
  }

  withRetry({ run, label, selectorToWait }) {
    return pRetry(
      async () => {
        try {
          return await run()
        } catch (err) {
          if (err instanceof Error) {
            throw err
          } else {
            this.log(
              'warn',
              `caught an Error which is not instance of Error: ${
                err?.message || JSON.stringify(err)
              }`
            )
            throw new Error(err?.message || err)
          }
        }
      },
      {
        retries: 5,
        onFailedAttempt: async error => {
          // sometimes, on some devices, this error is raised without any known reason. We try to
          // reload the current page (to refresh any needed token) and retry the function
          if (['Failed to fetch', 'Load failed'].includes(error.message)) {
            this.log(
              'warn',
              `Retrying ${label}, attempt ${error.attemptNumber} on ${error.message} error`
            )
            await this.evaluateInWorker(() => window.location.reload())
            await new Promise(resolve => window.setTimeout(resolve, 1000)) // wait for reload command to be given to worker
            await this.waitForElementInWorker(selectorToWait)
          } else {
            throw error
          }
        }
      }
    )
  }

  async PromiseRaceWithError(promises, msg) {
    try {
      this.log('debug', msg)
      await Promise.race(promises)
    } catch (err) {
      if (err instanceof Error) {
        this.log('warn', err?.message || err)
      } else {
        this.log(
          'warn',
          `caught an Error which is not instance of Error: ${
            err?.message || JSON.stringify(err)
          }`
        )
      }
      throw new Error(`${msg} failed to meet conditions`)
    }
  }
}

const connector = new EdfContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getKyJson',
      'waitForLoginForm',
      'checkOtpNeeded',
      'checkConnected',
      'checkMultipleContracts',
      'waitForHomeProfile',
      'getHomeProfile',
      'getContractElec',
      'getConsumptions',
      'waitForSessionStorage',
      'logout',
      'getMultiContractsIds',
      'selectContract',
      'changeContract',
      'getContractPdlNumber',
      'waitForVendorErrorMessage'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

function getDateDistanceInDays(dateString) {
  const distanceMs = Date.now() - new Date(dateString).getTime()
  const days = 1000 * 60 * 60 * 24

  return Math.floor(distanceMs / days)
}
