require('dotenv').config();
const fetch = require('node-fetch');
const Discord = require('discord.js');
const path = require('path');
const fs = require('fs');
const util = require('util');
const { exec, execSync } = require('child_process');
const execPromise = util.promisify(exec);
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = (client) => {
    client.on('interactionCreate', async interaction => {
        if (!interaction.isChatInputCommand()) return;
        const { commandName } = interaction;
        if (commandName == 'stitch') {
            const userID = interaction.user.id
            const link = interaction.options.getString('link')
            const height = interaction.options.getInteger('height')
            const format = interaction.options.getString('format')
            const width = interaction.options.getInteger('width')

            let fileID
            if (link.split('?id=').length == 2) {
                fileID = link.split('?id=')[1]
            } else if (link.split('?usp=').length == 0) {
                fileID = link.split('/')[5]
            } else if (link.split('?').length == 0) {
                fileID = link.split('/')[5]
            } else {
                fileID = link.split('/')[5].split('?')[0]
            }

            const pinteraction = await interaction.deferReply({ content: 'Processing...', fetchReply: true });

            let folderName
            let folderName1
            try {
                // Get folder info
                const folderInfo = execSync(`gdrive files info ${fileID}`)
                if (folderInfo) {
                    const infoOutput = Buffer.from(folderInfo, 'utf-8').toString()
                    console.log(infoOutput)
                    const timestamp = new Date().getTime()
                    const arg = infoOutput.split("\n")
                    const nameArgs = arg[1].split(": ")
                    folderName = nameArgs[1] + "-" + timestamp
                    folderName1 = nameArgs[1]
                }
            } catch (err) {
                console.error("Error fetching gdrive info:", err);
                return interaction.followUp({ content: "Error fetching folder info", ephemeral: true });
            }

            let outputPAth
            let StitchPath
            // Setup paths
            if (folderName1.includes(" ")) {
                outputPAth = path.join(__dirname, `./downloads/${userID}/${folderName.replace(/ /g, "_")}/"${folderName1}"/"${folderName1}_Stitched"/`)
                console.log(outputPAth)
                StitchPath = path.join(__dirname, `./downloads/${userID}/${folderName.replace(/ /g, "_")}/"${folderName1}"`)
            } else {
                outputPAth = path.join(__dirname, `./downloads/${userID}/${folderName}/${folderName1}/${folderName1}_Stitched`)
                StitchPath = path.join(__dirname, `./downloads/${userID}/${folderName}/${folderName1}`)
            }
            const Dwnloadpath = path.join(__dirname, `./downloads/${userID}/${folderName.replace(/ /g, "_")}`)

            // Construct SmartStitch command based on processing options
            let stitchCmd = `SmartStitch -i ${StitchPath} -sh ${height} -t .${format}`;
            if (width != null) {
                stitchCmd += ` -cw ${width}`;
            }

            // Define workflow steps
            const workflow = [
                {
                    name: 'Download',
                    command: `gdrive files download ${fileID} --overwrite --recursive --path ${Dwnloadpath} --skip`,
                },
                {
                    name: 'Stitch',
                    command: stitchCmd
                },
                {
                    name: 'Zip',
                    command: `zip -r chapter-${folderName1.replace(/ /g, "_")}.zip *`,
                    options: {
                        cwd: outputPAth
                    }
                },
                {
                    name: 'Upload',
                    command: `rclone copy ${outputPAth} Golden1:/stitched_BOT/${folderName1.replace(/ /g, "_")}_Stitched`,
                },
                {
                    name: 'Link',
                    command: `rclone link Golden1:/stitched_BOT/${folderName1.replace(/ /g, "_")}_Stitched`,
                    isResult: true
                }
            ];

            try {
                // Execute commands sequentially
                for (const step of workflow) {
                    console.log(`[${step.name}] Executing: ${step.command}`);

                    const { stdout, stderr } = await execPromise(step.command, step.options || {});

                    if (stdout) console.log(`[${step.name}] stdout: ${stdout}`);
                    if (stderr) console.log(`[${step.name}] stderr: ${stderr}`);

                    // Handle result
                    if (step.isResult) {
                        try {
                            await interaction.user.send(`chapter-${folderName1}: ${stdout}`);
                            await interaction.followUp({ content: "See Your DM", ephemeral: true });
                            const message = await interaction.fetchReply();
                            message.react("✅");
                        } catch (dmError) {
                            console.error("Failed to send DM:", dmError);
                            await interaction.followUp({ content: `Finished, but failed to DM. Link: ${stdout}`, ephemeral: true });
                        }
                    }
                }
            } catch (err) {
                console.error("Workflow failed:", err);
                await interaction.followUp({ content: `An error occurred: ${err.message}`, ephemeral: true });
            } finally {
                // Cleanup downloaded files
                try {
                    if (fs.existsSync(Dwnloadpath)) {
                        console.log(`Cleaning up: ${Dwnloadpath}`);
                        fs.rmSync(Dwnloadpath, { recursive: true, force: true });
                    }
                } catch (cleanupErr) {
                    console.error("Cleanup failed:", cleanupErr);
                }
            }
        }
    })
}