import Minilog from '@cozy/minilog'

const log = Minilog('Utils')

export function convertResidenceType(residenceType) {
  const residenceTypeMap = {
    Principale: 'primary',
    Secondaire: 'secondary'
  }
  const result = residenceTypeMap[residenceType]

  if (!result) {
    log.warn('unknown residence type : ' + residenceType)
  }
  return result
}

export function convertHousingType(housingType) {
  const housingTypeMap = {
    Appartement: 'appartment',
    Maison: 'house'
  }
  const result = housingTypeMap[housingType]

  if (!result) {
    log.warn('unknown housing type : ' + housingType)
  }
  return result
}

export function convertHeatingSystem(heatingSystem) {
  const heatingSystemMap = {
    Collectif: 'collective',
    Electricite: 'electric',
    Gaz: 'gaz',
    Fioul: 'fuel',
    Solaire: 'solar',
    Bois: 'wood',
    Charbon: 'coal',
    Propane: 'propane',
    Autre: 'other'
  }
  const result = heatingSystemMap[heatingSystem]

  if (!result) {
    log.warn('unknown heating system : ' + heatingSystem)
  }

  return result
}

export function convertBakingTypes(bakingTypes = {}) {
  const result = Object.keys(bakingTypes).reduce(
    (memo, e) =>
      bakingTypes[e]
        ? [...memo, { type: e.slice(0, -6), number: bakingTypes[e] }]
        : memo,
    []
  )
  return result
}

export function convertWaterHeatingSystem(waterHeatingSystem) {
  const waterHeatingSystemMap = {
    Collectif: 'collective',
    Electricite: 'electric',
    Gaz: 'gaz',
    Fioul: 'fuel',
    Solaire: 'solar',
    Bois: 'wood',
    Charbon: 'coal',
    Propane: 'propane',
    Autre: 'other'
  }
  const result = waterHeatingSystemMap[waterHeatingSystem]

  if (!result) {
    log.warn('unknown water heating system : ' + waterHeatingSystem)
  }

  return result
}

export function convertConsumption(yearlyData = [], monthlyData = []) {
  const monthsIndexByYear = monthlyData.reduce((memo, d) => {
    const [year, month] = d.month.split('-')
    const intYear = parseInt(year, 10)
    const intMonth = parseInt(month, 10)
    if (!memo[intYear]) {
      memo[intYear] = []
    }
    memo[intYear].push({
      month: intMonth,
      consumptionkWh: d.consumption.energy
    })
    return memo
  }, {})

  const result = []
  for (const data of yearlyData) {
    const yearResult = {
      year: parseInt(data.year, 10),
      consumptionkWh: data.consumption.energy,
      months: monthsIndexByYear[data.year]
    }
    result.push(yearResult)
  }
  return result
}

export function getEnergyTypeFromContract(contract) {
  return contract?.subscribeOffer?.energy === 'ELECTRICITE'
    ? 'electricity'
    : 'gas'
}

export function formatHousing(
  contracts,
  echeancierResult,
  housingArray,
  logFn
) {
  const result = []
  for (const oneHousing of housingArray) {
    const consumptions = {
      electricity: convertConsumption(
        oneHousing.rawConsumptions?.elec?.yearlyElecEnergies,
        oneHousing.rawConsumptions?.elec?.monthlyElecEnergies
      ),
      gas: convertConsumption(
        oneHousing.rawConsumptions?.gas?.yearlyGasEnergies,
        oneHousing.rawConsumptions?.gas?.monthlyGasEnergies
      )
    }
    const contractId = checkPdlNumber(contracts, oneHousing.pdlNumber)
    if (!contractId) {
      logFn(
        'debug',
        `Could not find the contract ${oneHousing.pdlNumber} in existing contracts. This may be an expired contract.`
      )
      continue
    }
    const detail = contracts.details[contractId]
    const energyProviders = detail.contracts.map(c => {
      const energyType = getEnergyTypeFromContract(c)
      const mappedContract = {
        vendor: 'edf.fr',
        contract_number: c.number,
        energy_type: energyType,
        contract_type: c?.subscribeOffer?.offerName,
        powerkVA: parseInt(
          oneHousing.contractElec?.supplyContractParameters?.SUBSCRIBED_POWER,
          10
        ),
        [energyType + '_consumptions']: consumptions[energyType],
        charging_type: echeancierResult?.isMonthly ? 'monthly' : 'yearly'
      }

      // even if the api does not show it, real pdl number for gas is pce_number
      const pdlKeyMap = {
        electricity: 'pdl_number',
        gas: 'pce_number'
      }
      return {
        ...mappedContract,
        [pdlKeyMap[energyType]]: c.pdlnumber
      }
    })
    const housing = {
      construction_year: oneHousing.constructionDate,
      residence_type: convertResidenceType(oneHousing.residenceType),
      housing_type: convertHousingType(oneHousing.housingType),
      residents_number: oneHousing.lifeStyle.noOfOccupants,
      living_space_m2: oneHousing.surfaceInSqMeter,
      heating_system: convertHeatingSystem(
        oneHousing.heatingSystem.principalHeatingSystemType
      ),
      water_heating_system: convertWaterHeatingSystem(
        oneHousing.equipment?.sanitoryHotWater?.sanitoryHotWaterType
      ),
      baking_types: convertBakingTypes(oneHousing.equipment.cookingEquipment),
      address: detail.adress,
      energy_providers: energyProviders
    }
    result.push(housing)
  }
  return result
}

function checkPdlNumber(contracts, pdlNumber) {
  const detailsKeys = Object.keys(contracts.details)
  for (const key of detailsKeys) {
    const foundContracts = contracts.details[key].contracts
    for (const contract of foundContracts) {
      if (contract.pdlnumber === pdlNumber) {
        return contracts.details[key].number.substring(2)
      }
    }
  }
  return false
}
