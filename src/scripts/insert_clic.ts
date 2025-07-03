import { PrismaClient } from '../prisma/client/index.js'
const prisma = new PrismaClient()

async function main() {
    const res = await prisma.clicPage.findFirst(
        {
            where: {
                id: 1
            }
        }
    )
    console.log(res)
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })

